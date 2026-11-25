import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { downloadPrebuiltCompilerArtifacts, verifyCachedArtifacts } from './build-llvm-wasm.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(scriptDir, '..');
export const webRoot = join(repoRoot, 'apps', 'web');
export const distRoot = join(webRoot, 'dist');
export const cacheRoot = join(repoRoot, 'toolchain', 'llvm-wasm', 'cache');
export const llvmManifestPath = join(repoRoot, 'toolchain', 'llvm-wasm', 'manifest.json');

/** @param {string} path */
export const sha256File = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');

/** @param {string} path @param {string} indent */
const walkFiles = async (path, indent = '') => {
  /** @type {string[]} */
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(full, indent));
    else files.push(relative(distRoot, full).replaceAll('\\', '/'));
  }
  return files;
};

/** @param {string[]} args @param {string} name */
const option = (args, name) => {
  const exact = args.find((arg) => arg.startsWith(`${name}=`));
  return exact?.slice(name.length + 1);
};

/** Verify and acquire the pinned prebuilt LLVM WASM artifacts without invoking native compilation. */
export const acquirePinnedLlvm = async () => {
  const manifest = JSON.parse(await readFile(llvmManifestPath, 'utf8'));
  let cache = await verifyCachedArtifacts(cacheRoot, manifest);
  if (cache.llvmStatus !== 'verified') {
    const released = await downloadPrebuiltCompilerArtifacts(cacheRoot, manifest);
    if (!released.downloaded) {
      throw new Error(`Pinned LLVM WASM prebuilt acquisition failed: ${released.diagnostics.join(' ')}`);
    }
    cache = await verifyCachedArtifacts(cacheRoot, manifest);
  }
  if (cache.llvmStatus !== 'verified') {
    throw new Error(`LLVM WASM cache verification failed: llvm=${cache.llvmStatus}, ld=${cache.ldStatus}`);
  }
  if (!cache.ld || cache.ldStatus !== 'verified') {
    throw new Error(`Pinned LLVM linker verification failed: ld=${cache.ldStatus}`);
  }
  return { manifest, cache };
};

/** @param {Record<string,unknown>} manifest @param {{llvmPath:string,ldPath:string,llvm:string|null,ld:string|null,llvmStatus:string,ldStatus:string}} cache */
export const validateDistribution = async (manifest, cache) => {
  const integrity = /** @type {Record<string,string>} */ (manifest.integrity ?? {});
  const llvmExpected = integrity['llvm.wasm'];
  const ldExpected = integrity['ld.wasm'];
  if (!cache.llvm || cache.llvm !== llvmExpected) throw new Error('Pinned llvm.wasm cache does not match the LLVM manifest');
  if (!cache.ld || cache.ld !== ldExpected) throw new Error('Pinned ld.wasm cache does not match the LLVM manifest');

  const required = [
    'index.html',
    'registry/boards.json',
    'registry/llvm-wasm/package.json',
    'examples/index.json',
    'toolchain/llvm.wasm',
    'toolchain/ld.wasm'
  ];
  for (const file of required) {
    const path = join(distRoot, file);
    if (!existsSync(path)) throw new Error(`Required production asset is missing: ${file}`);
  }

  for (const [name, cachePath] of [['llvm.wasm', cache.llvmPath], ['ld.wasm', cache.ldPath]]) {
    const distPath = join(distRoot, 'toolchain', name);
    if (await sha256File(distPath) !== await sha256File(cachePath)) {
      throw new Error(`Production toolchain asset differs from cache: ${name}`);
    }
  }

  const index = await readFile(join(distRoot, 'index.html'), 'utf8');
  if (/\bsrc="\/|\bhref="\//.test(index)) throw new Error('index.html contains an absolute root asset URL');

  const files = await walkFiles(distRoot);
  const textFiles = [];
  for (const file of files) {
    if (!/\.(js|css|html|json|txt)$/i.test(file)) continue;
    textFiles.push(await readFile(join(distRoot, file), 'utf8'));
  }
  const deployedText = textFiles.join('\n');
  for (const forbidden of ['http://localhost:', '/api/asset-download', '/api/library-download']) {
    if (deployedText.includes(forbidden)) throw new Error(`Production output contains development-only dependency: ${forbidden}`);
  }

  const stagedSdks = files.filter((file) => file.startsWith('assets/') && file.endsWith('.zip'));
  const registryRoot = join(repoRoot, 'registry');
  for (const entry of await readdir(registryRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(registryRoot, entry.name, 'package.json');
    try {
      const packageManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      const distribution = packageManifest.metadata?.distribution;
      const expected = typeof distribution?.sha256 === 'string' ? distribution.sha256 : null;
      if (!expected) continue;
      const stagedPath = join(distRoot, 'assets', `${entry.name}-${packageManifest.version}.zip`);
      if (!existsSync(stagedPath)) continue;
      if (await sha256File(stagedPath) !== expected.toLowerCase()) {
        throw new Error(`Staged SDK SHA-256 mismatch: ${entry.name}-${packageManifest.version}.zip`);
      }
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }

  return { required, stagedSdks, files: files.length, sizeBytes: (await Promise.all(files.map((file) => stat(join(distRoot, file))))).reduce((total, info) => total + info.size, 0) };
};

/** @param {string} archivePath */
const createZipArchive = async (archivePath) => {
  await mkdir(dirname(archivePath), { recursive: true });
  const zip = spawnSync('zip', ['-qr', archivePath, '.'], { cwd: distRoot, stdio: 'inherit' });
  if (zip.error) throw zip.error;
  if (zip.status !== 0) throw new Error(`ZIP archive creation failed with status ${zip.status}`);
};

export const main = async (args = process.argv.slice(2)) => {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: npm run build:release:web [--skip-archive] [--archive=PATH]');
    console.log('');
    console.log('Release-safety warning: this command can generate a large public distribution artifact.');
    console.log('Do not run it arbitrarily, in scheduled automation, or by an agent.');
    console.log('A release, tag, GitHub publication, or Pages deployment requires separate explicit user consent.');
    console.log('The command itself builds locally and does not publish or deploy by default.');
    return 0;
  }

  console.warn('Wicro web release build: this may download large assets and generate a public distribution. Run only with the user\'s explicit consent; this command does not publish or deploy.');

  const webPackage = JSON.parse(await readFile(join(webRoot, 'package.json'), 'utf8'));
  const version = String(webPackage.version);
  const tag = `web-v${version}`;
  const archiveOption = option(args, '--archive');
  const archivePath = resolve(repoRoot, archiveOption ?? `artifacts/wicro-web-v${version}.zip`);

  console.log(JSON.stringify({ stage: 'acquire-pinned-llvm', tag, version, llvmManifest: llvmManifestPath }, null, 2));
  const acquired = await acquirePinnedLlvm();

  console.log(JSON.stringify({ stage: 'build-production-web', tag, llvm: acquired.cache.llvmStatus, ld: acquired.cache.ldStatus }, null, 2));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const build = spawnSync(npm, ['run', 'build', '--workspace', '@wicro/web'], { cwd: repoRoot, stdio: 'inherit' });
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error(`Production web build failed with status ${build.status}`);

  const validation = await validateDistribution(acquired.manifest, acquired.cache);

  const preliminaryReport = {
    ok: true,
    tag,
    version,
    llvmVersion: acquired.manifest.version,
    llvmReleaseTag: acquired.manifest.release?.tag,
    archive: null,
    archiveSha256: null,
    ...validation
  };
  await writeFile(join(distRoot, 'release.json'), `${JSON.stringify(preliminaryReport, null, 2)}\n`);

  if (!args.includes('--skip-archive')) {
    await createZipArchive(archivePath);
  }

  const report = {
    ...preliminaryReport,
    archive: args.includes('--skip-archive') ? null : archivePath,
    archiveSha256: args.includes('--skip-archive') ? null : await sha256File(archivePath)
  };
  await writeFile(join(distRoot, 'release.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  return 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
