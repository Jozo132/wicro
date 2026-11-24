import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const scriptDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
export const repoRoot = resolve(scriptDir, '..');
export const llvmToolchainDir = resolve(repoRoot, 'toolchain', 'llvm-wasm');
export const cacheDir = resolve(llvmToolchainDir, 'cache');
export const manifestPath = resolve(llvmToolchainDir, 'manifest.json');
export const registryManifestPath = resolve(repoRoot, 'registry', 'llvm-wasm', 'package.json');
export const releasePlanDir = resolve(llvmToolchainDir, '.release');
export const releasePlanPath = resolve(releasePlanDir, 'plan.json');
export const releaseNotesPath = resolve(releasePlanDir, 'RELEASE_NOTES.md');

export const DEFAULT_REPO = 'Jozo132/wicro';
export const RELEASE_TAG_PREFIX = 'llvm-wasm-v';

/** @param {unknown} value @returns {value is Record<string,unknown>} */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {Buffer} bytes */
export const validateWasmStructure = (bytes) => {
  if (bytes.length < 8) return { valid: false, diagnostics: ['Artifact is shorter than the 8-byte WASM header.'] };
  if (bytes.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d])) === false) {
    return { valid: false, diagnostics: ['Artifact does not start with the WebAssembly magic bytes.'] };
  }
  if (bytes.readUInt32LE(4) !== 1) return { valid: false, diagnostics: ['Artifact uses an unsupported WebAssembly binary version.'] };

  let offset = 8;
  let sections = 0;
  while (offset < bytes.length) {
    if (offset + 1 > bytes.length) return { valid: false, diagnostics: ['Truncated WASM section header.'] };
    offset += 1;
    let size = 0;
    let shift = 0;
    let complete = false;
    while (shift < 35 && offset < bytes.length) {
      const byte = bytes[offset++];
      size |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        complete = true;
        break;
      }
      shift += 7;
    }
    if (!complete) return { valid: false, diagnostics: ['Truncated or invalid WASM section size.'] };
    if (size < 0 || offset + size > bytes.length) return { valid: false, diagnostics: ['Truncated WASM section payload.'] };
    offset += size;
    sections += 1;
  }
  return { valid: sections > 0, diagnostics: sections > 0 ? [] : ['Artifact contains no WASM sections.'] };
};

/** @param {string} bytesPath */
export const sha256File = async (bytesPath) => createHash('sha256').update(await readFile(bytesPath)).digest('hex');

/** @param {string} tag */
export const parseLlvmReleaseTag = (tag) => {
  if (typeof tag !== 'string' || !tag.startsWith(RELEASE_TAG_PREFIX)) return null;
  const version = tag.slice(RELEASE_TAG_PREFIX.length);
  return semver.valid(version) ? semver.clean(version) : null;
};

/** @param {'patch'|'minor'|'major'} bump @param {string|null} [latestVersion] @returns {string} */
export const bumpReleaseVersion = (bump = 'patch', latestVersion = null) => {
  if (!['patch', 'minor', 'major'].includes(bump)) throw new Error(`Invalid bump '${bump}'. Use patch, minor, or major.`);
  if (latestVersion === null) return '1.0.0';
  if (!semver.valid(latestVersion)) throw new Error(`Invalid latest LLVM WASM version '${latestVersion}'.`);
  const next = semver.inc(latestVersion, /** @type {import('semver').ReleaseType} */ (bump));
  if (!next) throw new Error(`Could not bump LLVM WASM version '${latestVersion}'.`);
  return next;
};

/** @param {Record<string,unknown>[]} releases */
export const classifyLlvmReleases = (releases) => {
  /** @type {{published:Record<string,unknown>[],draft:Record<string,unknown>[],prerelease:Record<string,unknown>[],tagOnly:Record<string,unknown>[]}} */
  const result = { published: [], draft: [], prerelease: [], tagOnly: [] };
  for (const release of releases) {
    if (!isRecord(release)) continue;
    const tag = typeof release.tag_name === 'string' ? release.tag_name : typeof release.tag === 'string' ? release.tag : '';
    if (release.tag_only === true) {
      if (parseLlvmReleaseTag(tag)) result.tagOnly.push(release);
      continue;
    }
    if (!parseLlvmReleaseTag(tag)) continue;
    if (release.draft === true) result.draft.push(release);
    else if (release.prerelease === true) result.prerelease.push(release);
    else result.published.push(release);
  }
  result.published.sort((a, b) => semver.rcompare(parseLlvmReleaseTag(String(a.tag_name)) ?? '0.0.0', parseLlvmReleaseTag(String(b.tag_name)) ?? '0.0.0'));
  result.draft.sort((a, b) => semver.rcompare(parseLlvmReleaseTag(String(a.tag_name)) ?? '0.0.0', parseLlvmReleaseTag(String(b.tag_name)) ?? '0.0.0'));
  result.prerelease.sort((a, b) => semver.rcompare(parseLlvmReleaseTag(String(a.tag_name)) ?? '0.0.0', parseLlvmReleaseTag(String(b.tag_name)) ?? '0.0.0'));
  result.tagOnly.sort((a, b) => semver.rcompare(parseLlvmReleaseTag(String(a.tag_name)) ?? '0.0.0', parseLlvmReleaseTag(String(b.tag_name)) ?? '0.0.0'));
  return result;
};

/** @param {typeof fetch} fetchImpl @param {string} url @param {Record<string,string>} headers @param {number} [retries] */
export const fetchGitHubWithRetry = async (fetchImpl, url, headers, retries = 3) => {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, { headers });
      if (response?.ok) return response;
      if (response?.status && response.status < 500 && response.status !== 429) return response;
      lastError = new Error(`GitHub API HTTP ${response?.status ?? 'unknown'}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
  }
  throw lastError instanceof Error ? lastError : new Error('GitHub API request failed.');
};

/** @param {string} repo @param {{fetchImpl?:typeof fetch,token?:string|null,retries?:number}} [options] */
export const discoverGitHubReleases = async (repo = DEFAULT_REPO, options = {}) => {
  const parts = repo.split('/');
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) throw new Error(`Invalid GitHub repository '${repo}'. Use owner/repo.`);
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? await getGhToken();
  const releases = [];
  const tagNames = new Set();
  let page = 1;

  while (true) {
    const url = `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`;
    /** @type {any} */
    let response;
    try {
      response = await fetchGitHubWithRetry(fetchImpl, url, {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      }, options.retries ?? 3);
    } catch (error) {
      throw new Error(`GitHub release discovery failed for ${repo}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response?.ok) {
      const status = response?.status ?? 'unknown';
      throw new Error(`GitHub release discovery failed (${status}). Authenticate with 'gh auth login' and verify network access.`);
    }
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error('GitHub API returned an invalid release list.');
    releases.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }

  for (let tagPage = 1; ; tagPage += 1) {
    const tagsUrl = `https://api.github.com/repos/${repo}/git/matching-refs/tags/${encodeURIComponent(RELEASE_TAG_PREFIX)}?per_page=100&page=${tagPage}`;
    try {
      const response = await fetchImpl(tagsUrl, {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          ...(token ? { authorization: `Bearer ${token}` } : {})
        }
      });
      if (!response?.ok) break;
      const refs = await response.json();
      if (!Array.isArray(refs)) break;
      for (const ref of refs) {
        if (typeof ref?.ref === 'string') tagNames.add(ref.ref.slice('refs/tags/'.length));
      }
      if (refs.length < 100) break;
    } catch {
      break;
    }
  }

  const releasedTagNames = new Set(releases.map((release) => typeof release.tag_name === 'string' ? release.tag_name : '').filter(Boolean));
  const tagOnly = [...tagNames].filter((tag) => parseLlvmReleaseTag(tag) && !releasedTagNames.has(tag)).map((tag) => ({ tag_name: tag, tag_only: true }));
  return [...releases, ...tagOnly];
};

/** @returns {Promise<string|null>} */
const getGhToken = async () => {
  const gh = process.platform === 'win32' ? 'gh.exe' : 'gh';
  const result = spawnSync(gh, ['auth', 'token'], { encoding: 'utf8', stdio: 'pipe' });
  if (result.error || result.status !== 0) return null;
  const token = String(result.stdout ?? '').trim();
  return token || null;
};

/** @param {string} cache @param {Record<string,unknown>|null} [manifest] */
export const inspectLocalArtifacts = async (cache = cacheDir, manifest = null) => {
  /** @type {{filename:string,size:number|null,sha256:string|null,valid:boolean,diagnostics:string[],structure:{valid:boolean,diagnostics:string[]}|null}[]} */
  const artifacts = [];
  for (const filename of ['llvm.wasm', 'ld.wasm']) {
    const path = resolve(cache, filename);
    if (!existsSync(path)) {
      artifacts.push({ filename, size: null, sha256: null, valid: false, diagnostics: [`${filename} is missing.`], structure: null });
      continue;
    }
    const bytes = await readFile(path);
    const fileStat = await stat(path);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const structure = validateWasmStructure(bytes);
    const diagnostics = [...structure.diagnostics];
    const declared = manifest && isRecord(manifest.integrity) ? /** @type {Record<string,unknown>} */ (manifest.integrity)[filename] : null;
    if (typeof declared === 'string' && declared !== sha256) diagnostics.push(`${filename} differs from the existing manifest SHA-256.`);
    artifacts.push({ filename, size: fileStat.size, sha256, valid: structure.valid, diagnostics, structure });
  }
  return {
    valid: artifacts.every((artifact) => artifact.valid),
    artifacts,
    llvm: artifacts.find((artifact) => artifact.filename === 'llvm.wasm') ?? null,
    ld: artifacts.find((artifact) => artifact.filename === 'ld.wasm') ?? null
  };
};

/** @param {Record<string,unknown>} existing @param {string} version @param {string} repo @param {string} tag @param {ReturnType<typeof inspectLocalArtifacts> extends Promise<infer T> ? T : never} local @param {'none'|'br'|'gzip'} [compression] @param {string} [sourceCache] @returns {Record<string,unknown>} */
export const generateManifest = (existing, version, repo, tag, local, compression = 'none', sourceCache = cacheDir) => {
  if (!local.valid) throw new Error('Cannot generate a release manifest from missing or invalid local artifacts.');
  const llvm = local.artifacts.find((artifact) => artifact.filename === 'llvm.wasm');
  const ld = local.artifacts.find((artifact) => artifact.filename === 'ld.wasm');
  if (!llvm?.sha256) throw new Error('llvm.wasm SHA-256 is unavailable.');

  const baseUrl = `https://github.com/${repo}/releases/download/${tag}`;
  const manifest = /** @type {Record<string,unknown>} */ (structuredClone(existing));
  manifest.version = version;
  manifest.repository = `https://github.com/${repo}`;
  manifest.release = {
    repository: repo,
    tag,
    publishedUrl: `https://github.com/${repo}/releases/tag/${tag}`,
    createdAt: new Date().toISOString()
  };

  manifest.artifacts = manifest.artifacts && isRecord(manifest.artifacts) ? manifest.artifacts : {};
  const artifacts = /** @type {Record<string,Record<string,unknown>>} */ (manifest.artifacts);
  let clangEncoded = null;
  if (compression === 'br') clangEncoded = brotliCompressSync(readFileSync(resolve(sourceCache, 'llvm.wasm')));
  else if (compression === 'gzip') clangEncoded = gzipSync(readFileSync(resolve(sourceCache, 'llvm.wasm')));
  const clangDistributionFilename = clangEncoded ? `llvm.wasm.${compression === 'br' ? 'br' : 'gz'}` : 'llvm.wasm';
  const clangDistributionSha = clangEncoded ? createHash('sha256').update(clangEncoded).digest('hex') : llvm.sha256;
  artifacts.clang = {
    ...(isRecord(artifacts.clang) ? artifacts.clang : {}),
    url: `${baseUrl}/${clangDistributionFilename}`,
    filename: 'llvm.wasm',
    distributionFilename: clangDistributionFilename,
    sha256: clangDistributionSha,
    uncompressedSha256: llvm.sha256,
    size: clangEncoded ? clangEncoded.length : llvm.size,
    uncompressedSize: llvm.size,
    compression: clangEncoded ? (compression === 'br' ? 'br' : 'gzip') : null,
    mirrors: []
  };
  if (ld?.valid && ld.sha256) {
    let ldEncoded = null;
    if (compression === 'br') ldEncoded = brotliCompressSync(readFileSync(resolve(sourceCache, 'ld.wasm')));
    else if (compression === 'gzip') ldEncoded = gzipSync(readFileSync(resolve(sourceCache, 'ld.wasm')));
    const ldDistributionFilename = ldEncoded ? `ld.wasm.${compression === 'br' ? 'br' : 'gz'}` : 'ld.wasm';
    const ldDistributionSha = ldEncoded ? createHash('sha256').update(ldEncoded).digest('hex') : ld.sha256;
    artifacts.ld = {
      ...(isRecord(artifacts.ld) ? artifacts.ld : {}),
      url: `${baseUrl}/${ldDistributionFilename}`,
      filename: 'ld.wasm',
      distributionFilename: ldDistributionFilename,
      sha256: ldDistributionSha,
      uncompressedSha256: ld.sha256,
      size: ldEncoded ? ldEncoded.length : ld.size,
      uncompressedSize: ld.size,
      compression: ldEncoded ? (compression === 'br' ? 'br' : 'gzip') : null,
      mirrors: []
    };
  } else {
    delete artifacts.ld;
  }

  manifest.tools = {
    clang: { url: 'llvm.wasm', argv0: 'clang' },
    ...(ld?.valid ? { ld: { url: 'ld.wasm', argv0: 'ld' } } : {})
  };
  const entryPoints = isRecord(manifest.entryPoints) ? manifest.entryPoints : {};
  manifest.entryPoints = {
    ...entryPoints,
    combined: ['clang', 'clang++', 'ld.lld', 'ld', 'lld'],
    available: ld?.valid ? ['clang', 'ld'] : ['clang'],
    separateRequired: ['clangd.wasm', 'clang-tidy.wasm', 'clang-format.wasm', 'llvm-ar.wasm', 'llvm-objcopy.wasm', 'llvm-objdump.wasm', 'llvm-size.wasm', 'llvm-nm.wasm', 'llvm-readelf.wasm']
  };
  manifest.integrity = {
    'llvm.wasm': llvm.sha256,
    ...(ld?.valid && ld.sha256 ? { 'ld.wasm': ld.sha256 } : {})
  };
  const existingProvenance = isRecord(existing.provenance) ? existing.provenance : {};
  manifest.provenance = {
    ...existingProvenance,
    buildPlatform: process.platform,
    buildArchitecture: process.arch,
    reproducible: true
  };
  return manifest;
};

/** @param {Record<string,unknown>} manifest @param {string} version @param {string} repo @param {string} tag */
export const generateReleaseNotes = (manifest, version, repo, tag) => {
  const artifacts = isRecord(manifest.artifacts) ? manifest.artifacts : {};
  const lines = [`# LLVM WASM ${version}`, '', `- Distribution tag: \`${tag}\``, `- GitHub repository: https://github.com/${repo}`, '', '## Artifacts', ''];
  for (const name of ['clang', 'ld']) {
    const artifact = isRecord(artifacts[name]) ? artifacts[name] : null;
    if (!artifact) continue;
    lines.push(`- \`${String(artifact.filename)}\`: ${String(artifact.size)} bytes, SHA-256 \`${String(artifact.uncompressedSha256)}\``);
  }
  const revisions = isRecord(manifest.revisions) ? manifest.revisions : {};
  lines.push('', '## Provenance', '', `- LLVM upstream: \`${String(revisions['llvm-project'] ?? 'unknown')}\``, `- LLVM commit: \`${String(revisions['llvm-project-commit'] ?? 'unknown')}\``, `- Espressif source: \`${String(revisions['esp-wasm'] ?? 'unknown')}\``, `- WASI SDK: \`${String(revisions['wasi-sdk'] ?? 'unknown')}\``, '', 'Release assets and hashes were generated locally and must be independently verified before publication.');
  return `${lines.join('\n')}\n`;
};

/** @param {Record<string,unknown>} manifest */
export const generateSha256Sums = (manifest) => {
  const artifacts = isRecord(manifest.artifacts) ? manifest.artifacts : {};
  const lines = [];
  for (const name of ['clang', 'ld']) {
    const artifact = isRecord(artifacts[name]) ? artifacts[name] : null;
    if (!artifact) continue;
    const distributionFilename = typeof artifact.distributionFilename === 'string' ? artifact.distributionFilename : String(artifact.filename);
    const distributionHash = String(artifact.sha256);
    const filename = String(artifact.filename);
    const uncompressedHash = String(artifact.uncompressedSha256);
    if (!/^[a-f0-9]{64}$/.test(distributionHash)) throw new Error(`Invalid SHA-256 for ${distributionFilename}.`);
    if (!/^[a-f0-9]{64}$/.test(uncompressedHash)) throw new Error(`Invalid uncompressed SHA-256 for ${filename}.`);
    lines.push(`${distributionHash}  ${distributionFilename}`);
    if (distributionFilename !== filename) lines.push(`${uncompressedHash}  ${filename}`);
  }
  return `${lines.join('\n')}\n`;
};

/** @param {string[]} [releases] @param {'patch'|'minor'|'major'} [bump] @param {string|null} [latestTagOnly] */
export const calculateNextVersion = (releases = [], bump = 'patch', latestTagOnly = null) => {
  const publishedVersions = /** @type {string[]} */ (releases.map((release) => parseLlvmReleaseTag(typeof release === 'string' ? release : '')).filter((version) => typeof version === 'string'));
  const latest = publishedVersions.length > 0 ? semver.sort(publishedVersions).at(-1) : null;
  return bumpReleaseVersion(bump, latest ?? (latestTagOnly ? semver.clean(latestTagOnly) : null));
};

/** @param {unknown} manifest */
export const validateManifest = (manifest) => {
  if (!isRecord(manifest)) return { valid: false, diagnostics: ['Manifest must be a JSON object.'] };
  const diagnostics = [];
  if (manifest.name !== 'llvm-wasm') diagnostics.push("Manifest name must be 'llvm-wasm'.");
  if (typeof manifest.version !== 'string' || !semver.valid(manifest.version)) diagnostics.push('Manifest distribution version must be valid SemVer.');
  if (!isRecord(manifest.artifacts) || !isRecord(manifest.artifacts.clang)) diagnostics.push('Manifest must contain a clang artifact.');
  if (!isRecord(manifest.release)) diagnostics.push('Manifest must contain release metadata.');
  if (!isRecord(manifest.revisions)) diagnostics.push('Manifest must contain upstream revisions.');
  if (!isRecord(manifest.integrity)) diagnostics.push('Manifest must contain artifact integrity hashes.');
  if (isRecord(manifest.artifacts)) {
    for (const [name, artifact] of Object.entries(manifest.artifacts)) {
      if (!isRecord(artifact)) { diagnostics.push(`Artifact '${name}' must be an object.`); continue; }
      const filename = typeof artifact.filename === 'string' ? artifact.filename : '';
      const hash = typeof artifact.uncompressedSha256 === 'string' ? artifact.uncompressedSha256 : '';
      if (!filename) diagnostics.push(`Artifact '${name}' must have a filename.`);
      if (!/^[a-f0-9]{64}$/.test(hash)) diagnostics.push(`Artifact '${name}' must have a 64-character SHA-256 hash.`);
      if (typeof artifact.size !== 'number' || artifact.size < 1) diagnostics.push(`Artifact '${name}' must have an accurate size.`);
      if (typeof artifact.url !== 'string' || artifact.url.length === 0) diagnostics.push(`Artifact '${name}' must have a version-pinned URL.`);
    }
  }
  return { valid: diagnostics.length === 0, diagnostics };
};

const ghExecutable = () => process.platform === 'win32' ? 'gh.exe' : 'gh';

/** @param {string[]} args */
export const runGh = (args) => {
  const result = spawnSync(ghExecutable(), args, { encoding: 'utf8', stdio: 'pipe', cwd: repoRoot });
  if (result.error) throw new Error(`GitHub CLI unavailable: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`GitHub CLI failed: ${String(result.stderr ?? result.stdout ?? '').trim() || `exit ${result.status}`}`);
  return String(result.stdout ?? '').trim();
};

/** @param {string[]} args @returns {any} */
export const runGhJson = (args) => {
  const output = runGh(args);
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`GitHub CLI returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/** @param {string} dir @param {string[]} [files] */
const findPackageJsonFiles = async (dir, files = []) => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'cache', 'dist'].includes(entry.name)) continue;
      await findPackageJsonFiles(path, files);
    } else if (entry.name === 'package.json') {
      files.push(path);
    }
  }
  return files;
};

/** @param {Record<string,unknown>} manifest */
export const synchronizeRepositoryManifests = async (manifest) => {
  const validation = validateManifest(manifest);
  if (!validation.valid) throw new Error(`Cannot synchronize invalid manifest: ${validation.diagnostics.join(' ')}`);
  /** @type {string[]} */
  const changedFiles = [];
  /** @param {string} path @param {string} text */
  const writeIfChanged = async (path, text) => {
    const before = existsSync(path) ? await readFile(path, 'utf8') : null;
    if (before !== text) {
      await atomicWriteText(path, text);
      changedFiles.push(path);
    }
  };

  await writeIfChanged(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeIfChanged(resolve(repoRoot, 'packages', 'wicro', 'toolchain', 'llvm-wasm', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const registryPackage = isRecord(await readJsonIfPresent(registryManifestPath)) ? await readJsonIfPresent(registryManifestPath) : {};
  const packageRecord = /** @type {Record<string,unknown>} */ (registryPackage);
  packageRecord.name = 'llvm-wasm';
  packageRecord.version = String(manifest.version);
  packageRecord.kind = 'toolchain';
  packageRecord.description = typeof manifest.description === 'string' ? manifest.description : 'Shared Espressif LLVM/LLD WebAssembly toolchain';
  packageRecord.license = typeof manifest.license === 'string' ? manifest.license : 'Apache-2.0 WITH LLVM-exception';
  packageRecord.repository = typeof manifest.repository === 'string' ? manifest.repository : `https://github.com/${DEFAULT_REPO}`;
  const existingMetadata = isRecord(packageRecord.metadata) ? packageRecord.metadata : {};
  packageRecord.metadata = {
    ...existingMetadata,
    runtime: manifest.runtime,
    compiler: 'toolchain/llvm-wasm/cache/llvm.wasm',
    linker: 'toolchain/llvm-wasm/cache/ld.wasm',
    targets: manifest.targets,
    availableEntryPoints: isRecord(manifest.entryPoints) && Array.isArray(manifest.entryPoints.available) ? manifest.entryPoints.available : ['clang'],
    requestedEntryPoints: isRecord(manifest.entryPoints) && Array.isArray(manifest.entryPoints.separateRequired) ? manifest.entryPoints.separateRequired.map((entry) => String(entry).replace(/\.wasm$/, '').replace(/-/g, '-')) : [],
    offlineCache: 'toolchain/llvm-wasm/cache',
    threadSupport: isRecord(manifest.targetConfiguration) ? manifest.targetConfiguration.threads === true : false,
    threadCompatibility: isRecord(manifest.targetConfiguration) ? String(manifest.targetConfiguration.reason ?? '') : '',
    distributionRelease: manifest.release,
    revisions: manifest.revisions
  };
  packageRecord.artifacts = manifest.artifacts;
  packageRecord.tools = manifest.tools;
  packageRecord.entryPoints = manifest.entryPoints;
  packageRecord.revisions = manifest.revisions;
  packageRecord.integrity = manifest.integrity;
  packageRecord.release = manifest.release;
  await writeIfChanged(registryManifestPath, `${JSON.stringify(packageRecord, null, 2)}\n`);
  await writeIfChanged(resolve(repoRoot, 'packages', 'wicro', 'registry', 'llvm-wasm', 'package.json'), `${JSON.stringify(packageRecord, null, 2)}\n`);

  for (const path of await findPackageJsonFiles(resolve(repoRoot, 'registry'))) {
    const pkg = await readJsonIfPresent(path);
    if (!isRecord(pkg) || !isRecord(pkg.dependencies)) continue;
    if (pkg.dependencies['llvm-wasm'] !== undefined) {
      pkg.dependencies['llvm-wasm'] = `^${String(manifest.version)}`;
      await writeIfChanged(path, `${JSON.stringify(pkg, null, 2)}\n`);
    }
  }
  for (const path of await findPackageJsonFiles(resolve(repoRoot, 'packages', 'wicro', 'registry'))) {
    const pkg = await readJsonIfPresent(path);
    if (!isRecord(pkg) || !isRecord(pkg.dependencies)) continue;
    if (pkg.dependencies['llvm-wasm'] !== undefined) {
      pkg.dependencies['llvm-wasm'] = `^${String(manifest.version)}`;
      await writeIfChanged(path, `${JSON.stringify(pkg, null, 2)}\n`);
    }
  }
  return changedFiles;
};

/** @param {string} path @returns {Promise<Record<string,unknown>>} */
const readJsonIfPresent = async (path) => /** @type {Record<string,unknown>} */ (existsSync(path) ? JSON.parse(await readFile(path, 'utf8')) : {});

/** @param {{repo:string,manifest:Record<string,unknown>,local:Awaited<ReturnType<typeof inspectLocalArtifacts>>,verbose:boolean}} options */
export const publishPreparedRelease = async (options) => {
  const release = isRecord(options.manifest.release) ? options.manifest.release : null;
  const tag = release && typeof release.tag === 'string' ? release.tag : null;
  if (!tag) throw new Error('Prepared manifest has no release tag.');
  const work = await mkdtemp(join(tmpdir(), 'wicro-llvm-release-'));
  /** @type {{id:number,url:string,assets:string[],changedFiles:string[]}} */
  let draft = { id: 0, url: '', assets: [], changedFiles: [] };
  try {
    const existingReleases = runGhJson(['api', `repos/${options.repo}/releases?per_page=100`]);
    const resumableDraft = Array.isArray(existingReleases)
      ? existingReleases.find((release) => release?.draft === true && release?.tag_name === tag)
      : null;

    if (resumableDraft) {
      draft = /** @type {any} */ (resumableDraft);
    } else {
      const bodyPath = resolve(work, 'release.json');
      await atomicWriteJson(bodyPath, {
        tag_name: tag,
        name: `LLVM WASM ${String(options.manifest.version)}`,
        body: generateReleaseNotes(options.manifest, String(options.manifest.version), options.repo, tag),
        draft: true,
        prerelease: false
      });
      draft = /** @type {any} */ (runGhJson(['api', '--method', 'POST', `repos/${options.repo}/releases`, '--input', bodyPath]));
    }
    const draftId = Number(draft.id);
    if (!draftId) throw new Error('GitHub did not return a draft release ID.');

    const uploadPaths = [];
    const artifacts = isRecord(options.manifest.artifacts) ? options.manifest.artifacts : {};
    for (const name of ['clang', 'ld']) {
      const artifact = isRecord(artifacts[name]) ? artifacts[name] : null;
      if (!artifact) continue;
      const distributionFilename = typeof artifact.distributionFilename === 'string' ? artifact.distributionFilename : String(artifact.filename);
      const distributionPath = resolve(work, distributionFilename);
      const raw = readFileSync(resolve(cacheDir, String(artifact.filename)));
      if (artifact.compression === 'br') await writeFile(distributionPath, brotliCompressSync(raw));
      else if (artifact.compression === 'gzip') await writeFile(distributionPath, gzipSync(raw));
      else await writeFile(distributionPath, raw);
      uploadPaths.push(distributionPath);
    }
    await atomicWriteJson(resolve(work, 'manifest.json'), options.manifest);
    await writeFile(resolve(work, 'SHA256SUMS'), generateSha256Sums(options.manifest), 'utf8');
    await writeFile(resolve(work, 'RELEASE_NOTES.md'), generateReleaseNotes(options.manifest, String(options.manifest.version), options.repo, tag), 'utf8');
    uploadPaths.push(resolve(work, 'manifest.json'), resolve(work, 'SHA256SUMS'), resolve(work, 'RELEASE_NOTES.md'));

    let existingDraftRelease = runGhJson(['api', `repos/${options.repo}/releases/${draftId}`]);
    /** @type {{name:string,size?:number,browser_download_url:string,url?:string}[]} */
    let publicAssets = Array.isArray(existingDraftRelease.assets) ? existingDraftRelease.assets : [];
    const existingAssetNames = publicAssets.map((asset) => String(asset.name));
    const missingUploadPaths = uploadPaths.filter((path) => !existingAssetNames.includes(basename(path)));
    if (missingUploadPaths.length > 0) {
      const uploadArgs = ['release', 'upload', tag, ...missingUploadPaths, '--repo', options.repo];
      runGh(uploadArgs);
      existingDraftRelease = runGhJson(['api', `repos/${options.repo}/releases/${draftId}`]);
      publicAssets = Array.isArray(existingDraftRelease.assets) ? existingDraftRelease.assets : [];
    }

    const assetNames = publicAssets.map((asset) => String(asset.name));
    const expectedNames = uploadPaths.map((path) => basename(path));
    const missing = expectedNames.filter((name) => !assetNames.includes(name));
    if (missing.length > 0) throw new Error(`Draft verification failed: missing uploaded assets ${missing.join(', ')}. Recovery: gh release view ${tag} --repo ${options.repo}; complete or delete the draft only if no published assets exist.`);

    await verifyDraftAssets(options.repo, String(draftId), options.manifest);

    runGh(['api', '--method', 'PATCH', `repos/${options.repo}/releases/${draftId}`, '-F', 'draft=false']);

    const published = await verifyPublishedRelease(options.repo, tag, options.manifest);
    draft.changedFiles = await synchronizeRepositoryManifests(options.manifest);
    await atomicWriteJson(resolve(releasePlanDir, 'draft.json'), { draftId, tag, publishedUrl: published.url, publishedAt: new Date().toISOString(), assets: published.assets });
    return { url: published.url, tag, assets: published.assets, changedFiles: draft.changedFiles };
  } catch (error) {
    if (draft.url) {
      await atomicWriteJson(resolve(releasePlanDir, 'draft.json'), { draftId: draft.id, tag, draftUrl: draft.url, recovery: `gh release view ${tag} --repo ${options.repo}` }).catch(() => {});
    }
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
};

/** @param {string} repo @param {string} draftId @param {Record<string,unknown>} manifest */
export const verifyDraftAssets = async (repo, draftId, manifest) => {
  const release = runGhJson(['api', `repos/${repo}/releases/${draftId}`]);
  if (!release || release.draft !== true) throw new Error(`Draft release ${draftId} was not found before publication.`);
  /** @type {{name:string,size?:number,browser_download_url:string,url?:string}[]} */
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const artifacts = isRecord(manifest.artifacts) ? manifest.artifacts : {};
  const token = await getGhToken();
  for (const name of ['clang', 'ld']) {
    const artifact = isRecord(artifacts[name]) ? artifacts[name] : null;
    if (!artifact) continue;
    const distributionFilename = typeof artifact.distributionFilename === 'string' ? artifact.distributionFilename : String(artifact.filename);
    const apiAsset = assets.find((asset) => asset.name === distributionFilename);
    if (!apiAsset) throw new Error(`Draft asset ${distributionFilename} is missing.`);
    if (typeof apiAsset.size === 'number' && Number(apiAsset.size) !== Number(artifact.size)) {
      throw new Error(`Draft asset ${distributionFilename} has size ${apiAsset.size}, expected ${String(artifact.size)}.`);
    }
    const downloadUrl = typeof apiAsset.url === 'string' ? apiAsset.url : String(apiAsset.browser_download_url);
    const response = await fetch(downloadUrl, {
      headers: {
        accept: 'application/octet-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      }
    });
    if (!response.ok) throw new Error(`Could not download draft asset ${distributionFilename}: HTTP ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== String(artifact.sha256)) throw new Error(`Draft asset ${distributionFilename} SHA-256 mismatch.`);
  }
  for (const filename of ['manifest.json', 'SHA256SUMS', 'RELEASE_NOTES.md']) {
    if (!assets.find((asset) => asset.name === filename)) throw new Error(`Draft asset ${filename} is missing.`);
  }
  return true;
};

/** @param {string} repo @param {string} tag @param {Record<string,unknown>} manifest */
export const verifyPublishedAssets = async (repo, tag, manifest) => verifyPublishedRelease(repo, tag, manifest);

/** @param {string} repo @param {string} tag @param {Record<string,unknown>} manifest */
export const verifyPublishedRelease = async (repo, tag, manifest) => {
  const release = runGhJson(['api', `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`]);
  if (!release || release.draft === true) throw new Error(`Published release ${tag} is missing or still a draft.`);
  /** @type {{name:string,size?:number,browser_download_url:string,url?:string}[]} */
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const artifacts = isRecord(manifest.artifacts) ? manifest.artifacts : {};
  const verified = [];
  for (const name of ['clang', 'ld']) {
    const artifact = isRecord(artifacts[name]) ? artifacts[name] : null;
    if (!artifact) continue;
    const distributionFilename = typeof artifact.distributionFilename === 'string' ? artifact.distributionFilename : String(artifact.filename);
    const apiAsset = assets.find((asset) => asset.name === distributionFilename);
    if (!apiAsset) throw new Error(`Published asset ${distributionFilename} is missing.`);
    if (typeof apiAsset.size === 'number' && Number(apiAsset.size) !== Number(artifact.size)) {
      throw new Error(`Published asset ${distributionFilename} has size ${apiAsset.size}, expected ${String(artifact.size)}.`);
    }
    const token = await getGhToken();
    const downloadUrl = typeof apiAsset.url === 'string' ? apiAsset.url : String(apiAsset.browser_download_url);
    const response = await fetch(downloadUrl, {
      headers: {
        accept: 'application/octet-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      }
    });
    if (!response.ok) throw new Error(`Could not download published asset ${distributionFilename}: HTTP ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== String(artifact.sha256)) throw new Error(`Published asset ${distributionFilename} SHA-256 mismatch.`);
    verified.push(distributionFilename);
  }
  const manifestAsset = assets.find((asset) => asset.name === 'manifest.json');
  if (!manifestAsset) throw new Error('Published manifest.json asset is missing.');
  const sumAsset = assets.find((asset) => asset.name === 'SHA256SUMS');
  if (!sumAsset) throw new Error('Published SHA256SUMS asset is missing.');
  return { url: typeof release.html_url === 'string' ? release.html_url : `https://github.com/${repo}/releases/tag/${tag}`, assets: verified, manifestAsset: manifestAsset.name, sha256Asset: sumAsset.name };
};

/** @param {Record<string,unknown>} release @param {Record<string,unknown>[]} releases */
export const findReleaseConflict = (release, releases) => {
  const tag = typeof release.tag_name === 'string' ? release.tag_name : String(release.tag ?? '');
  const version = parseLlvmReleaseTag(tag);
  if (!version) return null;
  const collision = releases.find((candidate) => candidate.tag_name === tag || candidate.tag === tag);
  if (!collision) return null;
  return { tag, version, state: collision.tag_only ? 'tag-only' : collision.draft ? 'draft' : collision.prerelease ? 'prerelease' : 'published' };
};

/** @param {Record<string,unknown>} manifest @param {string} outputDir */
export const stageReleasePlan = async (manifest, outputDir = releasePlanDir) => {
  await mkdir(outputDir, { recursive: true });
  await atomicWriteJson(resolve(outputDir, 'plan.json'), manifest);
  const shaPath = resolve(outputDir, 'SHA256SUMS');
  await writeFile(shaPath, generateSha256Sums(manifest), 'utf8');
  const notes = generateReleaseNotes(manifest, String(manifest.version), String(/** @type {Record<string,unknown>} */ (manifest.release).repository), String(/** @type {Record<string,unknown>} */ (manifest.release).tag));
  await writeFile(resolve(outputDir, 'RELEASE_NOTES.md'), notes, 'utf8');
};

/** @param {string} path @param {string} content */
export const atomicWriteText = async (path, content) => {
  await mkdir(resolve(path, '..'), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, content, 'utf8');
  try {
    await rename(tempPath, path);
  } catch (error) {
    await rm(path, { force: true });
    await rename(tempPath, path);
  }
};

/** @param {string} path @param {unknown} value */
export const atomicWriteJson = async (path, value) => atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);

/** @param {unknown} value */
export const parseArgs = (value) => {
  const argv = Array.isArray(value) ? value : [];
  const options = { command: argv[0] ?? 'status', json: false, verbose: false, version: null, bump: null, tag: null, repo: DEFAULT_REPO, compression: 'none', authorization: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg?.startsWith('--bump=')) options.bump = arg.slice('--bump='.length);
    else if (arg?.startsWith('--tag=')) options.tag = arg.slice('--tag='.length);
    else if (arg?.startsWith('--repo=')) options.repo = arg.slice('--repo='.length);
    else if (arg?.startsWith('--compression=')) options.compression = arg.slice('--compression='.length);
    else if (arg?.startsWith('--publish-authorization=')) options.authorization = arg.slice('--publish-authorization='.length);
    else if (arg?.startsWith('--version=')) options.version = arg.slice('--version='.length);
  }
  return /** @type {{command:string,json:boolean,verbose:boolean,version:string|null,bump:string|null,tag:string|null,repo:string,compression:string,authorization:string|null}} */ (options);
};

/** @returns {Promise<Record<string,unknown>>} */
const getExistingManifest = async () => /** @type {Record<string,unknown>} */ (JSON.parse(await readFile(manifestPath, 'utf8')));

/** @param {string} text @param {boolean} json */
const writeOutput = (text, json) => {
  if (json) return;
  process.stdout.write(text);
};

/** @param {string[]} argv */
export const main = async (argv = process.argv.slice(2)) => {
  const options = parseArgs(argv);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`Usage: node scripts/release-llvm-wasm.js <status|prepare|dry-run|publish|verify> [options]\n\nOptions:\n  --json                 Emit machine-readable JSON\n  --verbose              Include diagnostics and detailed asset data\n  --version=X.Y.Z        Use an exact distribution version\n  --bump=patch|minor|major\n  --tag=llvm-wasm-vX.Y.Z\n  --repo=owner/repo\n  --compression=none|br|gzip\n  --publish-authorization=I-AUTHORIZE-Wicro-LLVM-WASM-RELEASE\n`);
    return 0;
  }

  let releases;
  let remoteAvailable = true;
  try {
    releases = await discoverGitHubReleases(options.repo);
  } catch (error) {
    remoteAvailable = false;
    releases = [];
  }

  const classified = classifyLlvmReleases(releases);
  const latestPublished = classified.published.length > 0
    ? semver.clean(String(parseLlvmReleaseTag(String(classified.published[0].tag_name))))
    : null;
  const bump = /** @type {'patch'|'minor'|'major'} */ (options.bump ?? 'patch');
  const tagOnlyVersions = /** @type {string[]} */ (releases.filter((release) => release.tag_only).map((release) => parseLlvmReleaseTag(String(release.tag_name))).filter((version) => typeof version === 'string'));
  const latestTagOnly = tagOnlyVersions.length > 0 ? semver.sort(tagOnlyVersions).at(-1) : null;
  let proposedVersion = semver.clean(bumpReleaseVersion(bump, latestPublished ?? latestTagOnly));
  if (!proposedVersion) throw new Error('Could not calculate a valid LLVM WASM distribution version.');
  if (options.version) {
    if (!semver.valid(options.version)) throw new Error(`Invalid --version '${options.version}'. Use MAJOR.MINOR.PATCH.`);
    proposedVersion = semver.clean(options.version);
    if (!proposedVersion) throw new Error(`Invalid --version '${options.version}'. Use MAJOR.MINOR.PATCH.`);
  }
  const proposedTag = options.tag ?? `${RELEASE_TAG_PREFIX}${proposedVersion}`;
  if (parseLlvmReleaseTag(proposedTag) !== proposedVersion) throw new Error(`--tag '${proposedTag}' does not match distribution version '${proposedVersion}'.`);

  const existingManifest = await getExistingManifest();
  const local = await inspectLocalArtifacts(cacheDir, existingManifest);

  if (options.command === 'status') {
    const output = {
      remoteAvailable,
      repository: options.repo,
      releases: classified,
      latestPublished,
      latestTagOnly,
      proposedVersion,
      proposedTag,
      bump,
      localArtifacts: local
    };
    if (options.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    else {
      if (!remoteAvailable) process.stdout.write(`Remote: unavailable (run 'gh auth login' and retry; publish is blocked)\n`);
      else process.stdout.write(`Repository: ${options.repo}\nPublished LLVM WASM releases: ${classified.published.length}\nLatest: ${latestPublished ?? 'none'}\nNext: ${proposedVersion} (${bump})\nTag: ${proposedTag}\n`);
      for (const artifact of local.artifacts) process.stdout.write(`Local ${artifact.filename}: ${artifact.valid ? 'valid' : 'invalid'}${artifact.size === null ? '' : ` (${artifact.size} bytes)`}${artifact.sha256 ? ` ${artifact.sha256}` : ''}\n`);
    }
    return remoteAvailable ? 0 : 2;
  }

  if (!local.valid) {
    throw new Error(`Local artifact validation failed: ${local.artifacts.flatMap((artifact) => artifact.diagnostics).join(' ')}`);
  }
  if (!remoteAvailable) throw new Error("Remote verification is unavailable. Recheck GitHub before preparing or publishing this release.");

  const conflict = findReleaseConflict({ tag_name: proposedTag }, releases);
  const conflictIsAllowedForCommand =
    (options.command === 'publish' && conflict?.state === 'draft') ||
    (options.command === 'verify' && conflict?.state === 'published');
  if (conflict && !conflictIsAllowedForCommand) {
    throw new Error(`Release conflict: ${conflict.state} tag '${conflict.tag}' already exists. Choose another --version/--bump and never overwrite it.`);
  }

  if (options.command === 'prepare' || options.command === 'dry-run') {
    if (!['none', 'br', 'gzip'].includes(options.compression)) throw new Error("Invalid --compression. Use 'none', 'br', or 'gzip'.");
    const manifest = generateManifest(existingManifest, proposedVersion, options.repo, proposedTag, local, /** @type {'none'|'br'|'gzip'} */ (options.compression));
    const manifestValidation = validateManifest(manifest);
    if (!manifestValidation.valid) throw new Error(`Generated manifest is invalid: ${manifestValidation.diagnostics.join(' ')}`);
    if (options.command === 'prepare') {
      await stageReleasePlan(manifest, releasePlanDir);
    }
    const plan = {
      repository: options.repo,
      version: proposedVersion,
      tag: proposedTag,
      bump,
      remoteState: classified,
      assets: manifest.artifacts,
      sha256sums: generateSha256Sums(manifest),
      manifest,
      releaseNotes: generateReleaseNotes(manifest, proposedVersion, options.repo, proposedTag),
      staged: options.command === 'prepare',
      publishAllowed: false,
      gitOperations: ['No remote mutation', 'No Git tag creation until publish', 'Update toolchain/llvm-wasm/manifest.json after successful verification', 'Update registry/llvm-wasm/package.json and packages/wicro copies after verification']
    };
    if (options.json) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    else {
      process.stdout.write(`LLVM WASM release dry run\nVersion: ${proposedVersion}\nTag: ${proposedTag}\nRepository: ${options.repo}\n`);
      process.stdout.write(`\nAssets:\n${plan.sha256sums}`);
      process.stdout.write(`\nManifest URL updates:\n`);
      const manifestArtifacts = isRecord(manifest.artifacts) ? manifest.artifacts : {};
      for (const [name, artifact] of Object.entries(manifestArtifacts)) {
        if (isRecord(artifact)) process.stdout.write(`- ${name}: ${String(artifact.url)} (${String(artifact.size)} bytes)\n`);
      }
      process.stdout.write(`\nGit operations:\n- ${plan.gitOperations.join('\n- ')}\n`);
      if (options.command === 'prepare') process.stdout.write(`\nStaged plan: ${releasePlanPath}\nRelease notes: ${releaseNotesPath}\n`);
    }
    return 0;
  }

  if (options.command === 'publish') {
    if (options.authorization !== 'I-AUTHORIZE-Wicro-LLVM-WASM-RELEASE') {
      throw new Error("Publish requires --publish-authorization=I-AUTHORIZE-Wicro-LLVM-WASM-RELEASE and an existing staged plan.");
    }
    if (!existsSync(releasePlanPath)) throw new Error(`No staged release plan exists at ${releasePlanPath}. Run 'npm run release:llvm:prepare' first.`);
    const planManifest = /** @type {Record<string,unknown>} */ (JSON.parse(await readFile(releasePlanPath, 'utf8')));
    const planValidation = validateManifest(planManifest);
    if (!planValidation.valid) throw new Error(`Staged manifest is invalid: ${planValidation.diagnostics.join(' ')}`);
    const planRelease = /** @type {Record<string,unknown>|null} */ (isRecord(planManifest.release) ? planManifest.release : null);
    const plannedTag = planRelease && typeof planRelease.tag === 'string' ? planRelease.tag : null;
    if (plannedTag !== proposedTag || planManifest.version !== proposedVersion) {
      throw new Error(`Staged plan is for ${String(planManifest.version)} (${String(plannedTag)}), not ${proposedVersion} (${proposedTag}). Re-run prepare with matching options.`);
    }
    const publishedConflict = findReleaseConflict({ tag_name: proposedTag }, releases);
    if (publishedConflict && publishedConflict.state !== 'draft') {
      throw new Error(`Remote conflict detected: ${publishedConflict.state} tag '${publishedConflict.tag}' already exists. No assets were uploaded.`);
    }

    const result = await publishPreparedRelease({ repo: options.repo, manifest: planManifest, local, verbose: options.verbose });
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`Published ${proposedTag}: ${result.url}\nVerified ${result.assets.length} asset(s).\nUpdated ${result.changedFiles.length} repository manifest file(s).\n`);
    return 0;
  }
  if (options.command === 'verify') {
    if (!existsSync(releasePlanPath)) throw new Error(`No staged release plan exists at ${releasePlanPath}. Run 'npm run release:llvm:prepare' first.`);
    const planManifest = /** @type {Record<string,unknown>} */ (JSON.parse(await readFile(releasePlanPath, 'utf8')));
    const planRelease = /** @type {Record<string,unknown>|null} */ (isRecord(planManifest.release) ? planManifest.release : null);
    const plannedTag = planRelease && typeof planRelease.tag === 'string' ? planRelease.tag : null;
    if (!plannedTag) throw new Error('Staged manifest has no release tag.');
    const verified = await verifyPublishedRelease(options.repo, plannedTag, planManifest);
    if (options.json) process.stdout.write(`${JSON.stringify(verified, null, 2)}\n`);
    else process.stdout.write(`Verified published release ${plannedTag}: ${verified.url}\nAssets: ${verified.assets.join(', ')}\n`);
    return 0;
  }
  throw new Error(`Unknown command '${options.command}'. Use status, prepare, dry-run, publish, or verify.`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}
