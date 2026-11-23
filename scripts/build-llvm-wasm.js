import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(scriptDir, '..');
export const llvmToolchainDir = resolve(repoRoot, 'toolchain', 'llvm-wasm');

export const buildDefaults = Object.freeze({
  espWasmRef: 'dceb9e3126898359bff8ab9e44bec5b65d87b5d3',
  llvmRef: 'esp-20.1.1_20250829',
  llvmProjectCommit: '50f388758bdf0b0d99018a6f2b1d3402bdb51002',
  jobs: '24',
  llvmTargets: 'ARM;AVR;RISCV',
  wasiSdkVersion: '34.0'
});

/** @param {string} command @param {string[]} args @param {{cwd?:string,env?:NodeJS.ProcessEnv,stdio?:'inherit'|'pipe'}} [options] */
export const runCommand = (command, args, options = {}) => spawnSync(command, args, {
  cwd: options.cwd,
  encoding: 'utf8',
  env: options.env ?? process.env,
  stdio: options.stdio ?? 'inherit'
});

/** @param {string} name @param {string[]} [fallbacks] */
export const findExecutable = (name, fallbacks = []) => {
  for (const candidate of fallbacks) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = runCommand(finder, [name], { stdio: 'pipe' });
  if (result.error || result.status !== 0) return null;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? null;
};

/** @param {string} value */
export const shellQuote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** @param {string} bytesPath */
export const sha256File = async (bytesPath) => createHash('sha256').update(await readFile(bytesPath)).digest('hex');

/** @param {string} windowsPath */
export const toGitBashPath = (windowsPath) => {
  const normalized = windowsPath.replaceAll('\\', '/');
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  return match ? `/${match[1].toLowerCase()}/${match[2]}` : normalized;
};

/** @param {string} text */
export const parseVsDevShellOutput = (text) => {
  /** @type {NodeJS.ProcessEnv} */
  const environment = {};
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0) environment[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return environment;
};

/** @param {NodeJS.ProcessEnv} environment @param {string} name */
export const findExecutableInEnvironment = (environment, name) => {
  const pathValue = environment.PATH ?? environment.Path ?? environment.path ?? '';
  for (const dir of String(pathValue).split(';').map((value) => value.trim()).filter(Boolean)) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

/** @param {NodeJS.ProcessEnv} environment @param {string} name @param {string} installation */
export const findMsvcTool = (environment, name, installation) => {
  const vcTools = environment.VCToolsInstallDir;
  const candidates = [];
  if (vcTools) {
    candidates.push(join(vcTools, 'bin', 'Hostx64', 'x64', name));
    candidates.push(join(vcTools, 'bin', 'Hostx86', 'x64', name));
  }
  if (environment.VCINSTALLDIR) {
    candidates.push(join(environment.VCINSTALLDIR, 'bin', 'Hostx64', 'x64', name));
  }
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return findExecutableInEnvironment(environment, name);
};

/** @param {NodeJS.ProcessEnv} environment */
export const findWindowsSdk = (environment) => {
  const windowsSdkValue = environment.WindowsSdkDir;
  const windowsSdk = typeof windowsSdkValue === 'string' && windowsSdkValue.length > 0 ? windowsSdkValue : null;
  const sdkBinDir = environment.WindowsSdkBinPath ?? environment.WindowsSdkVerBinDir ?? null;
  const rcCandidates = [];
  if (sdkBinDir) rcCandidates.push(join(sdkBinDir, 'x64', 'rc.exe'), join(sdkBinDir, 'rc.exe'));
  if (windowsSdk) {
    rcCandidates.push(join(windowsSdk, 'bin', 'x64', 'rc.exe'));
    const versionedBin = environment.WindowsSDKVersion;
    if (versionedBin) rcCandidates.push(join(windowsSdk, 'bin', versionedBin, 'x64', 'rc.exe'));
  }
  for (const candidate of rcCandidates) if (existsSync(candidate)) {
    const rc = candidate;
    const include = environment.INCLUDE ?? '';
    const lib = environment.LIB ?? '';
    return { rc, windowsSdk, sdkBinDir: sdkBinDir ?? dirname(rc), sdkInclude: include, sdkLib: lib };
  }
  const rc = findExecutableInEnvironment(environment, 'rc.exe');
  return { rc, windowsSdk, sdkBinDir, sdkInclude: environment.INCLUDE ?? '', sdkLib: environment.LIB ?? '' };
};

/** @param {NodeJS.Platform} [platform] @param {NodeJS.ProcessEnv} [env] */
export const detectWindowsDeveloperEnvironment = (platform = process.platform, env = process.env) => {
  if (platform !== 'win32') {
    return { available: false, cl: null, link: null, rc: null, include: null, lib: null, vcTools: null, windowsSdk: null, sdkBinDir: null, shellEnvironment: env, diagnostics: ['MSVC detection is only applicable on Windows.'] };
  }

  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const programFiles = env.PROGRAMFILES ?? 'C:\\Program Files';
  const vsWhereCandidates = [
    join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'),
    join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'),
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe'
  ];
  const vsWhere = vsWhereCandidates.find((candidate) => existsSync(candidate)) ?? null;
  const installations = [];

  if (vsWhere) {
    const result = runCommand(vsWhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { stdio: 'pipe' });
    if (!result.error && result.status === 0) {
      for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
        if (line.trim()) installations.push(line.trim());
      }
    }
  }

  const diagnostics = [];
  for (const installation of installations) {
    const vsDevCmd = join(installation, 'Common7', 'Tools', 'VsDevCmd.bat');
    if (!existsSync(vsDevCmd)) continue;
    const wrapper = join(tmpdir(), `wicro-vsdev-${process.pid}-${Math.random().toString(16).slice(2)}.cmd`);
    const shellContent = `@call "${vsDevCmd}" -no_logo -arch=x64 -host_arch=x64\r\n@if errorlevel 1 exit /b %errorlevel%\r\n@set\r\n`;
    let result;
    try {
      writeFileSync(wrapper, shellContent, 'utf8');
      result = runCommand('cmd.exe', ['/d', '/c', wrapper], { stdio: 'pipe' });
    } catch {
      result = { error: new Error('Could not create the temporary VsDevCmd wrapper.'), status: 1, stdout: '', stderr: '' };
    } finally {
      rmSync(wrapper, { force: true });
    }
    if (result.error || result.status !== 0) continue;
    const shellEnvironment = { ...env, ...parseVsDevShellOutput(result.stdout ?? '') };
    const cl = findMsvcTool(shellEnvironment, 'cl.exe', installation);
    const link = findMsvcTool(shellEnvironment, 'link.exe', installation);
    const sdk = findWindowsSdk(shellEnvironment);
    const include = shellEnvironment.INCLUDE ?? '';
    const lib = shellEnvironment.LIB ?? '';
    if (!cl) diagnostics.push('Missing MSVC cl.exe. Install the Visual Studio C++ Desktop development workload.');
    if (!link) diagnostics.push('Missing MSVC link.exe. Install the Visual Studio C++ toolset (MSVC x64/x86 build tools).');
    if (!sdk.rc) diagnostics.push('Missing Windows SDK rc.exe. Install the Windows 10/11 SDK through the Visual Studio Installer.');
    if (!sdk.windowsSdk) diagnostics.push('Missing Windows SDK: WindowsSdkDir was not initialized. Run or initialize VsDevCmd.bat for x64.');
    if (!include) diagnostics.push('Missing Windows SDK/MSVC INCLUDE paths. Initialize VsDevCmd.bat -arch=x64 -host_arch=x64.');
    if (!lib) diagnostics.push('Missing Windows SDK/MSVC LIB paths. Initialize VsDevCmd.bat -arch=x64 -host_arch=x64.');
    const available = Boolean(cl && link && sdk.rc && sdk.windowsSdk && include && lib);
    if (available) {
      return { available, cl, link, rc: sdk.rc, include, lib, vcTools: shellEnvironment.VCToolsInstallDir ?? null, windowsSdk: sdk.windowsSdk, sdkBinDir: sdk.sdkBinDir, shellEnvironment, diagnostics: [] };
    }
  }

  const plainCl = findExecutableInEnvironment(env, 'cl.exe') ?? findExecutable('cl.exe');
  const plainLink = findExecutableInEnvironment(env, 'link.exe') ?? findExecutable('link.exe');
  const plainSdk = findWindowsSdk(env);
  const include = env.INCLUDE ?? '';
  const lib = env.LIB ?? '';
  if (!plainCl) diagnostics.push('Missing MSVC cl.exe. Install Visual Studio Build Tools and the C++ Desktop development workload.');
  if (!plainLink) diagnostics.push('Missing MSVC link.exe. Install the MSVC x64/x86 build tools component.');
  if (!plainSdk.rc) diagnostics.push('Missing Windows SDK rc.exe. Use Visual Studio Installer to add the Windows 10/11 SDK.');
  if (!plainSdk.windowsSdk) diagnostics.push('Missing Windows SDK directory. Install the Windows SDK and initialize it with VsDevCmd.bat.');
  if (!include) diagnostics.push('Missing MSVC/Windows SDK INCLUDE. The build cannot run from ordinary PowerShell until VsDevCmd.bat initializes it.');
  if (!lib) diagnostics.push('Missing MSVC/Windows SDK LIB. The build cannot run from ordinary PowerShell until VsDevCmd.bat initializes it.');
  const available = Boolean(plainCl && plainLink && plainSdk.rc && plainSdk.windowsSdk && include && lib);
  return {
    available,
    cl: plainCl,
    link: plainLink,
    rc: plainSdk.rc,
    include,
    lib,
    vcTools: env.VCToolsInstallDir ?? null,
    windowsSdk: plainSdk.windowsSdk,
    sdkBinDir: plainSdk.sdkBinDir,
    shellEnvironment: env,
    diagnostics
  };
};

/** @returns {{clang:string|null,cmake:string|null,ninja:string|null,git:string|null,curl:string|null,tar:string|null,cc:string|null,cxx:string|null,diagnostics:string[]}} */
export const detectUnixHostTools = () => {
  if (process.platform === 'win32') return { clang: null, cmake: null, ninja: null, git: null, curl: null, tar: null, cc: null, cxx: null, diagnostics: [] };
  const clang = findExecutable(process.platform === 'darwin' ? 'clang' : 'clang') ?? findExecutable('cc');
  const cxx = findExecutable(process.platform === 'darwin' ? 'clang++' : 'clang++') ?? findExecutable('c++');
  const cmake = findExecutable('cmake');
  const ninja = findExecutable('ninja');
  const git = findExecutable('git');
  const curl = findExecutable('curl');
  const tar = findExecutable('tar');
  const missing = [];
  if (!clang) missing.push('host C compiler (clang or cc)');
  if (!cxx) missing.push('host C++ compiler (clang++ or c++)');
  if (!cmake) missing.push('CMake');
  if (!ninja) missing.push('Ninja');
  if (!git) missing.push('Git');
  if (!curl) missing.push('curl');
  if (!tar) missing.push('tar');
  return {
    clang,
    cmake,
    ninja,
    git,
    curl,
    tar,
    cc: clang,
    cxx,
    diagnostics: missing.length > 0 ? [`Missing native ${process.platform} build prerequisites: ${missing.join(', ')}.`, 'Install the host compiler, CMake, Ninja, Git, curl, and tar through your platform package manager.'] : []
  };
};

/** @param {NodeJS.ProcessEnv} [env] */
export const detectWindowsTools = (env = process.env) => {
  if (process.platform !== 'win32') return { cmake: null, ninja: null, git: null, curl: null, tar: null, diagnostics: [] };
  const cmake = findExecutable('cmake.exe', [
    'C:\\llvm-tools\\cmake-4.1.2-windows-x86_64\\bin\\cmake.exe',
    join(env.PROGRAMFILES ?? 'C:\\Program Files', 'CMake', 'bin', 'cmake.exe'),
    join(env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'cmake.exe')
  ]);
  const ninja = findExecutable('ninja.exe', ['C:\\llvm-tools\\ninja.exe', join(env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'ninja.exe')]);
  const git = findExecutable('git.exe', [join(env.PROGRAMFILES ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe')]);
  const curl = findExecutable('curl.exe', ['C:\\Windows\\System32\\curl.exe']);
  const tar = findExecutable('tar.exe', ['C:\\Windows\\System32\\tar.exe']);
  const missing = [];
  if (!cmake) missing.push('CMake (install CMake with winget or the CMake installer)');
  if (!ninja) missing.push('Ninja (install Ninja with winget or download it to PATH)');
  if (!git) missing.push('Git for Windows (winget install --id Git.Git)');
  if (!curl) missing.push('curl.exe (install/repair Windows curl or add it to PATH)');
  if (!tar) missing.push('tar.exe (Git for Windows bsdtar or native Windows tar must be in PATH)');
  return {
    cmake,
    ninja,
    git,
    curl,
    tar,
    diagnostics: missing.length > 0 ? [`Missing native Windows build tools: ${missing.join(', ')}.`, 'Install CMake and Ninja natively; do not use WSL or Docker.'] : []
  };
};

/** @param {string} output @param {Record<string, unknown>} manifest */
export const verifyCachedArtifacts = async (output, manifest) => {
  const llvmPath = join(output, 'llvm.wasm');
  const ldPath = join(output, 'ld.wasm');
  const integrity = typeof manifest.integrity === 'object' && manifest.integrity !== null ? manifest.integrity : {};
  /** @type {Record<string,string>} */
  const hashes = /** @type {Record<string,string>} */ (integrity);
  let llvm = null;
  let ld = null;
  let llvmStatus = 'missing';

  if (existsSync(llvmPath)) {
    llvm = await sha256File(llvmPath);
    llvmStatus = hashes['llvm.wasm'] && llvm === hashes['llvm.wasm'] ? 'verified' : 'mismatch';
  }
  if (existsSync(ldPath)) {
    ld = await sha256File(ldPath);
  }
  return { llvmPath, ldPath, llvm, ld, llvmStatus, ldStatus: ld && hashes['ld.wasm'] ? (ld === hashes['ld.wasm'] ? 'verified' : 'mismatch') : 'not-present' };
};

/** @param {string} platform @param {string} arch */
export const wasiSdkAsset = (platform, arch) => {
  if (platform === 'win32') return 'wasi-sdk-34.0-x86_64-windows.tar.gz';
  if (platform === 'linux') return arch === 'arm64' ? 'wasi-sdk-34.0-arm64-linux.tar.gz' : 'wasi-sdk-34.0-x86_64-linux.tar.gz';
  if (platform === 'darwin') return arch === 'arm64' ? 'wasi-sdk-34.0-arm64-macos.tar.gz' : 'wasi-sdk-34.0-x86_64-macos.tar.gz';
  return null;
};

/** @param {string} wasiRoot @param {Record<string,unknown>} manifest */
/** @param {string} wasiRoot @param {Record<string,any>} manifest */
/** @param {string} wasiRoot @param {Record<string,any>} manifest */
export const verifyWasiSdk = (wasiRoot, manifest) => {
  const executable = process.platform === 'win32' ? 'clang.exe' : 'clang';
  const wasmLd = process.platform === 'win32' ? 'wasm-ld.exe' : 'wasm-ld';
  const clang = join(wasiRoot, 'bin', executable);
  const clangxx = join(wasiRoot, 'bin', process.platform === 'win32' ? 'clang++.exe' : 'clang++');
  const linker = join(wasiRoot, 'bin', wasmLd);
  const sysroot = join(wasiRoot, 'share', 'wasi-sysroot');
  const missing = [];
  if (!existsSync(clang)) missing.push(`WASI clang (${clang})`);
  if (!existsSync(clangxx)) missing.push(`WASI clang++ (${clangxx})`);
  if (!existsSync(linker)) missing.push(`WASI wasm-ld (${linker})`);
  if (!existsSync(sysroot)) missing.push(`WASI sysroot (${sysroot})`);
  const valid = missing.length === 0;
  const diagnostics = valid ? [] : [`WASI SDK ${manifest.revisions?.['wasi-sdk'] ?? '34.0'} is incomplete: ${missing.join('; ')}. Download the matching WASI SDK 34.0 platform archive or set WASI_SDK to a complete SDK directory.`];
  return { valid, clang, clangxx, linker, sysroot, missing, diagnostics };
};

/** @param {string} wasiRoot @param {string} url @param {string} curl */
export const downloadWasiSdk = async (wasiRoot, url, curl) => {
  await rm(wasiRoot, { recursive: true, force: true });
  await mkdir(wasiRoot, { recursive: true });
  const archive = join(dirname(wasiRoot), 'wasi-sdk.tar.gz');
  const download = runCommand(curl, ['-fL', '--retry', '3', '-o', archive, url]);
  if (download.error || download.status !== 0) throw new Error(`WASI SDK download failed: ${download.stderr || download.error?.message || `curl exited ${download.status}`}`);
  const extract = runCommand(process.platform === 'win32' ? 'tar.exe' : 'tar', ['xz', '-f', archive, '--strip-components=1', '-C', wasiRoot]);
  if (extract.error || extract.status !== 0) throw new Error(`WASI SDK extraction failed: ${extract.stderr || extract.error?.message || `tar exited ${extract.status}`}`);
  await rm(archive, { force: true });
};

/** @param {string} output @param {Record<string,unknown>} manifest */
export const updateUnifiedManifest = async (output, manifest) => {
  const names = await readdir(output).catch(() => []);
  const desired = ['clangd.wasm', 'clang-tidy.wasm', 'clang-format.wasm', 'llvm-ar.wasm', 'llvm-objcopy.wasm', 'llvm-objdump.wasm', 'llvm-size.wasm', 'llvm-nm.wasm', 'llvm-readelf.wasm'];
  /** @type {string[]} */
  const available = ['clang', 'ld'].filter((name) => names.includes(name === 'clang' ? 'llvm.wasm' : 'ld.wasm'));
  manifest.entryPoints = {
    ...(typeof manifest.entryPoints === 'object' && manifest.entryPoints !== null ? manifest.entryPoints : {}),
    available,
    separateRequired: desired.filter((name) => !names.includes(name)),
    lastBuild: new Date().toISOString()
  };
  const manifestPath = resolve(output, '..', 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const entryPoints = manifest.entryPoints && typeof manifest.entryPoints === 'object'
    ? /** @type {{separateRequired?:string[]}} */ (manifest.entryPoints)
    : {};
  return { available, separateRequired: entryPoints.separateRequired ?? [] };
};

/** @param {string} cache @param {Record<string,unknown>} manifest */
export const validateWasmArtifact = async (cache, manifest) => {
  const wasmPath = join(cache, 'llvm.wasm');
  if (!existsSync(wasmPath)) return { valid: false, wasm: null, diagnostics: ['llvm.wasm is missing.'] };
  const bytes = await readFile(wasmPath);
  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    return { valid: false, wasm: null, diagnostics: ['llvm.wasm has an invalid WASM header.'] };
  }
  const sha = createHash('sha256').update(bytes).digest('hex');
  const expected = typeof manifest.integrity === 'object' && manifest.integrity !== null
    ? /** @type {Record<string,string>} */ (manifest.integrity)['llvm.wasm']
    : null;
  return { valid: true, wasm: sha, expected, verified: Boolean(expected && sha === expected), diagnostics: expected && sha !== expected ? [`llvm.wasm SHA-256 differs from the verified manifest: actual=${sha}, expected=${expected}. Existing compilation tests must pass before publishing this replacement.`] : [] };
};

/** @param {string} work @param {Record<string,unknown>} manifest @param {{espWasmRef:string,llvmRef:string,llvmProjectCommit:string}} revisions @param {NodeJS.ProcessEnv} env @param {string} jobs */
const cloneAndPatchSource = async (work, manifest, revisions, env, jobs) => {
  const espDir = join(work, 'esp-wasm');
  const git = findExecutable('git.exe') ?? findExecutable('git');
  if (!git) throw new Error('Git is required to clone pinned LLVM source revisions.');

  const gitArgs = process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : [];
  let result = runCommand(git, [...gitArgs, 'clone', 'https://github.com/lemio/esp-wasm.git', espDir], { cwd: work, env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Failed to clone the pinned esp-wasm recipe repository.');
  result = runCommand(git, ['-C', espDir, 'checkout', '--detach', revisions.espWasmRef], { env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`Failed to check out esp-wasm revision ${revisions.espWasmRef}.`);

  const llvmDir = join(espDir, 'toolchain', 'out', 'llvm', 'src');
  await mkdir(llvmDir, { recursive: true });
  result = runCommand(git, ['clone', '--filter=blob:none', '--no-checkout', 'https://github.com/espressif/llvm-project.git', llvmDir], { cwd: work, env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Failed to clone the Espressif LLVM source repository.');
  result = runCommand(git, ['-C', llvmDir, 'fetch', '--depth', '1', 'origin', revisions.llvmProjectCommit], { env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`Failed to fetch LLVM source commit ${revisions.llvmProjectCommit}.`);
  result = runCommand(git, ['-C', llvmDir, 'checkout', '--detach', revisions.llvmProjectCommit], { env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`Failed to check out LLVM source commit ${revisions.llvmProjectCommit}.`);

  const patch = join(espDir, 'toolchain', 'patches', 'llvm-wasi-posix.patch');
  if (!existsSync(patch)) throw new Error(`Pinned WASI patch is missing: ${patch}`);
  const check = runCommand(git, ['-C', llvmDir, 'apply', '--check', patch], { env, stdio: 'pipe' });
  if (!check.error && check.status === 0) {
    const applied = runCommand(git, ['-C', llvmDir, 'apply', patch], { env, stdio: 'inherit' });
    if (applied.error || applied.status !== 0) throw new Error('Failed to apply the pinned LLVM WASI portability patch.');
  } else if (check.status !== 1) {
    throw new Error(`Could not verify the pinned LLVM WASI patch: ${check.stderr || 'git apply --check failed'}`);
  }

  return { espDir, llvmDir };
};

/** @param {string} work @param {string} output @param {Record<string,unknown>} manifest @param {{jobs:string,llvmTargets:string,offline:boolean,force:boolean}} options @param {NodeJS.ProcessEnv} env @param {{cmake:string,ninja:string,clang:string,cxx:string,hostCompilerEnv?:NodeJS.ProcessEnv}} tools @param {{clang:string,linker:string,sysroot:string}} wasi */
const compileSource = async (work, output, manifest, options, env, tools, wasi) => {
  const espDir = join(work, 'esp-wasm');
  const llvmDir = join(espDir, 'toolchain', 'out', 'llvm', 'src');

  const nativeDir = join(espDir, 'toolchain', 'out', 'llvm', 'native');
  const wasiDir = join(espDir, 'toolchain', 'out', 'llvm', 'wasi');
  const cmakeArgs = [
    '-S', join(llvmDir, 'llvm'),
    '-B', nativeDir,
    '-G', 'Ninja',
    '-DCMAKE_BUILD_TYPE=Release',
    `-DLLVM_TARGETS_TO_BUILD=${options.llvmTargets}`,
    '-DLLVM_EXPERIMENTAL_TARGETS_TO_BUILD=Xtensa',
    '-DLLVM_ENABLE_PROJECTS=clang',
    '-DLLVM_INCLUDE_TESTS=OFF',
    '-DLLVM_INCLUDE_BENCHMARKS=OFF',
    '-DLLVM_INCLUDE_EXAMPLES=OFF',
    '-DLLVM_BUILD_TOOLS=OFF',
    '-DCLANG_BUILD_TOOLS=OFF'
  ];
  if (tools.clang) cmakeArgs.push(`-DCMAKE_C_COMPILER=${tools.clang}`);
  if (tools.cxx) cmakeArgs.push(`-DCMAKE_CXX_COMPILER=${tools.cxx}`);

  let result = runCommand(toolsCmake(tools), cmakeArgs, { env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Native LLVM TableGen CMake configuration failed.');
  result = runCommand(tools.ninja, ['-j', options.jobs, '-C', nativeDir, 'llvm-tblgen', 'clang-tblgen'], { env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Native LLVM TableGen build failed.');

  const toolchainFile = join(espDir, 'toolchain', 'out', 'llvm', 'Toolchain-WASI.cmake');
  const flags = '-D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS';
  /** @param {string} value */
  const cmakePath = (value) => value.replaceAll('\\', '/');
  const wasiClang = cmakePath(wasi.clang);
  const wasiCxx = cmakePath(wasi.clang.replace(/clang(?:\.exe)?$/i, process.platform === 'win32' ? 'clang++.exe' : 'clang++'));
  const wasiLinker = cmakePath(wasi.linker);
  const wasiSysroot = cmakePath(wasi.sysroot);
  const wasiAr = cmakePath(process.platform === 'win32' ? wasi.clang.replace(/clang\.exe$/i, 'llvm-ar.exe') : dirname(wasi.linker) + '/llvm-ar');
  const wasiRanlib = cmakePath(process.platform === 'win32' ? wasi.clang.replace(/clang\.exe$/i, 'llvm-ranlib.exe') : dirname(wasi.linker) + '/llvm-ranlib');
  const toolchain = `set(CMAKE_SYSTEM_NAME WASI)
set(CMAKE_SYSTEM_VERSION 1)
set(CMAKE_SYSTEM_PROCESSOR wasm32)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
set(CMAKE_C_COMPILER "${wasiClang}")
set(CMAKE_C_COMPILER_TARGET wasm32-wasip1)
set(CMAKE_CXX_COMPILER "${wasiCxx}")
set(CMAKE_CXX_COMPILER_TARGET wasm32-wasip1)
set(CMAKE_LINKER "${wasiLinker}")
set(CMAKE_AR "${wasiAr}")
set(CMAKE_RANLIB "${wasiRanlib}")
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)
set(CMAKE_C_FLAGS "--sysroot ${wasiSysroot} -mcpu=lime1 ${flags}")
set(CMAKE_CXX_FLAGS "--sysroot ${wasiSysroot} -mcpu=lime1 ${flags}")
set(CMAKE_EXE_LINKER_FLAGS "--sysroot ${wasiSysroot} -lwasi-emulated-mman -lwasi-emulated-signal -lwasi-emulated-process-clocks -Wl,--initial-memory=33554432 -Wl,--extra-features=bulk-memory -Wl,--extra-features=sign-ext -Wl,--extra-features=mutable-globals -Wl,--extra-features=multivalue -Wl,--extra-features=reference-types -Wl,--extra-features=nontrapping-fptoint -Wl,--max-memory=4294967296 -Wl,-z,stack-size=8388608,--stack-first -Wl,--strip-all")
`;
  await writeFile(toolchainFile, toolchain);

  const toolsOff = [];
  for (const tool of ['SANCOV','LLVM_SYMBOLIZER','LLVM_SIZE','LLVM_READOBJ','LLVM_RC','LLVM_PROFDATA','LLVM_OBJDUMP','LLVM_OBJCOPY','LLVM_NM','LLVM_MT','LLVM_ML','LLVM_LIPO','LLVM_LIBTOOL_DARWIN','LLVM_IFS','LLVM_GSYMUTIL','LLVM_DWP','LLVM_DEBUGINFOD_FIND','LLVM_DEBUGINFOD','LLVM_CXXFILT','LLVM_CGDATA','LLVM_AR','DSYMUTIL']) {
    toolsOff.push(`-DLLVM_TOOL_${tool}_BUILD=OFF`);
  }

  const crossArgs = [
    '-S', join(llvmDir, 'llvm'),
    '-B', wasiDir,
    '-G', 'Ninja',
    `-DCMAKE_TOOLCHAIN_FILE=${toolchainFile}`,
    `-DLLVM_NATIVE_TOOL_DIR=${join(nativeDir, 'bin')}`,
    '-DCMAKE_BUILD_TYPE=MinSizeRel',
    '-DLLVM_ENABLE_ASSERTIONS=OFF',
    '-DLLVM_BUILD_SHARED_LIBS=OFF',
    '-DLLVM_ENABLE_PIC=OFF',
    '-DLLVM_BUILD_STATIC=ON',
    '-DLLVM_ENABLE_THREADS=OFF',
    '-DLLVM_BUILD_RUNTIME=OFF',
    '-DLLVM_BUILD_TOOLS=OFF',
    '-DLLVM_INCLUDE_UTILS=OFF',
    '-DLLVM_BUILD_UTILS=OFF',
    '-DLLVM_INCLUDE_RUNTIMES=OFF',
    '-DLLVM_INCLUDE_EXAMPLES=OFF',
    '-DLLVM_INCLUDE_TESTS=OFF',
    '-DLLVM_INCLUDE_BENCHMARKS=OFF',
    '-DLLVM_INCLUDE_DOCS=OFF',
    `-DLLVM_TARGETS_TO_BUILD=${options.llvmTargets}`,
    '-DLLVM_EXPERIMENTAL_TARGETS_TO_BUILD=Xtensa',
    '-DLLVM_DEFAULT_TARGET_TRIPLE=xtensa-esp-elf',
    '-DLLVM_TOOL_LLVM_DRIVER_BUILD=ON',
    ...toolsOff,
    '-DLLVM_ENABLE_PROJECTS=clang;lld',
    '-DLLVM_ENABLE_ZLIB=OFF',
    '-DLLVM_ENABLE_ZSTD=OFF',
    '-DLLVM_ENABLE_LIBXML2=OFF',
    '-DCLANG_ENABLE_ARCMT=OFF',
    '-DCLANG_ENABLE_STATIC_ANALYZER=OFF',
    '-DCLANG_INCLUDE_TESTS=OFF',
    '-DCLANG_BUILD_TOOLS=OFF',
    '-DCLANG_BUILD_EXAMPLES=OFF',
    '-DCLANG_INCLUDE_DOCS=OFF',
    '-DCLANG_TOOL_CLANG_SCAN_DEPS_BUILD=OFF',
    '-DCLANG_TOOL_CLANG_INSTALLAPI_BUILD=OFF',
    '-DCLANG_LINKS_TO_CREATE=clang;clang++',
    '-DLLD_BUILD_TOOLS=OFF',
    '-DCLANG_HAVE_RLIMITS=OFF',
    '-DLLVM_PARALLEL_LINK_JOBS=1'
  ];

  result = runCommand(toolsCmake(tools), crossArgs, { env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('WASI cross-compilation CMake configuration failed.');
  result = runCommand(tools.ninja, ['-j', options.jobs, '-k', '1', '-C', wasiDir, 'llvm-driver', 'clang-resource-headers'], { env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('WASI llvm-driver build failed.');

  const llvmBinary = join(wasiDir, 'bin', 'llvm');
  if (process.platform === 'win32' && existsSync(`${llvmBinary}.exe`)) return `${llvmBinary}.exe`;
  if (!existsSync(llvmBinary)) throw new Error(`LLVM WASI build did not produce ${llvmBinary}.`);
  return llvmBinary;
};

/** @param {{cmake:string,ninja:string}} tools */
const toolsCmake = (tools) => tools.cmake;

/** @param {string[]} args */
const parseArgs = (args) => {
  /** @type {{dryRun:boolean,force:boolean,offline:boolean,cacheOnly:boolean,help:boolean,subcommand:string,output:string|null}} */
  const options = { dryRun: false, force: false, offline: false, cacheOnly: false, help: false, subcommand: 'unified', output: null };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--offline') options.offline = true;
    else if (arg === '--cache-only') options.cacheOnly = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === 'common' || arg === 'unified') options.subcommand = arg;
    else if (!arg.startsWith('--') && options.output === null) options.output = arg;
  }
  return options;
};

export const main = async (args = process.argv.slice(2)) => {
  const options = parseArgs(args);
  if (options.help) {
    console.log('Usage: node scripts/build-llvm-wasm.js [unified|common] [output] [--dry-run] [--force] [--offline] [--cache-only]');
    console.log('  Verified llvm.wasm cache entries are used before host prerequisite checks.');
    console.log('  Windows uses the MSVC Visual Studio developer environment; WSL and Docker are not used.');
    return 0;
  }

  const manifest = JSON.parse(await readFile(resolve(llvmToolchainDir, 'manifest.json'), 'utf8'));
  const revisions = {
    espWasmRef: process.env.ESP_WASM_REF ?? manifest.revisions?.['esp-wasm'] ?? buildDefaults.espWasmRef,
    llvmRef: process.env.LLVM_REF ?? manifest.revisions?.['llvm-project'] ?? buildDefaults.llvmRef,
    llvmProjectCommit: manifest.revisions?.['llvm-project-commit'] ?? buildDefaults.llvmProjectCommit
  };
  const jobs = process.env.JOBS ?? buildDefaults.jobs;
  const llvmTargets = process.env.LLVM_TARGETS ?? buildDefaults.llvmTargets;
  const output = resolve(options.output ?? join(llvmToolchainDir, 'cache'));
  await mkdir(output, { recursive: true });

  const cache = await verifyCachedArtifacts(output, manifest);
  if (!options.force && cache.llvmStatus === 'verified') {
    console.log(JSON.stringify({ cache: 'verified', llvmWasm: cache.llvmPath, sha256: cache.llvm, ldStatus: cache.ldStatus }, null, 2));
    await updateUnifiedManifest(output, manifest);
    return 0;
  }

  if (options.cacheOnly) {
    console.error(`llvm.wasm cache is ${cache.llvmStatus}; --cache-only requires a verified SHA-256 cache entry.`);
    return 1;
  }

  if (options.dryRun) {
    if (process.platform === 'win32') {
      const msvc = detectWindowsDeveloperEnvironment('win32', process.env);
      const tools = detectWindowsTools(process.env);
      console.log(JSON.stringify({
        platform: process.platform,
        mode: 'dry-run',
        cache: cache.llvmStatus,
        msvc: { available: msvc.available, cl: msvc.cl, link: msvc.link, rc: msvc.rc, windowsSdk: msvc.windowsSdk, vsDevCmd: 'discovered automatically via vswhere for actual builds' },
        tools: { cmake: tools.cmake, ninja: tools.ninja, git: tools.git, curl: tools.curl, tar: tools.tar },
        wasiSdkAsset: wasiSdkAsset(process.platform, process.arch),
        llvmTargets,
        llvmRef: revisions.llvmRef,
        llvmProjectCommit: revisions.llvmProjectCommit
      }, null, 2));
      if (!msvc.available) console.error(msvc.diagnostics.join('\n'));
      if (tools.diagnostics.length > 0) console.error(tools.diagnostics.join('\n'));
      return 0;
    }

    if (process.platform === 'linux' || process.platform === 'darwin') {
      const tools = detectUnixHostTools();
      console.log(JSON.stringify({ platform: process.platform, mode: 'dry-run', cache: cache.llvmStatus, tools, wasiSdkAsset: wasiSdkAsset(process.platform, process.arch), llvmTargets, llvmRef: revisions.llvmRef, llvmProjectCommit: revisions.llvmProjectCommit }, null, 2));
      if (tools.diagnostics.length > 0) console.error(tools.diagnostics.join('\n'));
      return 0;
    }

    console.error(`Unsupported platform: ${process.platform}. Supported platforms are Windows, Linux, and macOS.`);
    return 1;
  }

  /** @type {NodeJS.ProcessEnv} */
  let buildEnv = { ...process.env, ESP_WASM_REF: revisions.espWasmRef, LLVM_REF: revisions.llvmRef, JOBS: jobs, LLVM_TARGETS: llvmTargets };
  let cmake = null;
  let ninja = null;
  let git = null;
  let curl = null;
  let tar = null;
  let clang = null;
  let cxx = null;

  if (process.platform === 'win32') {
    const msvc = detectWindowsDeveloperEnvironment('win32', process.env);
    const tools = detectWindowsTools(process.env);
    if (!msvc.available) {
      console.error(msvc.diagnostics.join('\n'));
      return 1;
    }
    const missing = [msvc.cl ? null : 'MSVC cl.exe', msvc.link ? null : 'MSVC link.exe', msvc.rc ? null : 'Windows SDK rc.exe', msvc.windowsSdk ? null : 'Windows SDK', msvc.include ? null : 'MSVC/Windows SDK INCLUDE', msvc.lib ? null : 'MSVC/Windows SDK LIB', tools.cmake ? null : 'CMake', tools.ninja ? null : 'Ninja', tools.git ? null : 'Git', tools.curl ? null : 'curl', tools.tar ? null : 'tar'].filter(Boolean);
    if (missing.length > 0) {
      console.error(`Missing native Windows build prerequisites: ${missing.join(', ')}`);
      console.error(tools.diagnostics.join('\n'));
      return 1;
    }
    buildEnv = {
      ...buildEnv,
      ...msvc.shellEnvironment,
      INCLUDE: msvc.include || msvc.shellEnvironment.INCLUDE || '',
      LIB: msvc.lib || msvc.shellEnvironment.LIB || '',
      WindowsSdkDir: msvc.windowsSdk || msvc.shellEnvironment.WindowsSdkDir || '',
      WindowsSdkBinPath: msvc.shellEnvironment.WindowsSdkBinPath || msvc.shellEnvironment.WindowsSdkVerBinDir || msvc.sdkBinDir || ''
    };
    cmake = tools.cmake;
    ninja = tools.ninja;
    git = tools.git;
    curl = tools.curl;
    tar = tools.tar;
    clang = msvc.cl;
    cxx = msvc.cl;
  } else if (process.platform === 'linux' || process.platform === 'darwin') {
    const tools = detectUnixHostTools();
    if (tools.diagnostics.length > 0) {
      console.error(tools.diagnostics.join('\n'));
      return 1;
    }
    cmake = tools.cmake;
    ninja = tools.ninja;
    git = tools.git;
    curl = tools.curl;
    tar = tools.tar;
    clang = tools.cc;
    cxx = tools.cxx;
  } else {
    console.error(`Unsupported platform: ${process.platform}. Supported platforms are Windows, Linux, and macOS.`);
    return 1;
  }

  if (!cmake || !ninja || !git || !curl || !tar) throw new Error('Host prerequisite detection did not provide all required tools.');

  const wasiRoot = process.env.WASI_SDK
    ? resolve(process.env.WASI_SDK)
    : join(output, 'wasi-sdk');
  let wasi = verifyWasiSdk(wasiRoot, manifest);
  if (!wasi.valid) {
    if (options.offline) {
      console.error(wasi.diagnostics.join('\n'));
      return 1;
    }
    const asset = wasiSdkAsset(process.platform, process.arch);
    if (!asset) throw new Error(`WASI SDK asset mapping is unavailable for ${process.platform}/${process.arch}.`);
    await downloadWasiSdk(wasiRoot, `https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${manifest.revisions?.['wasi-sdk'] ?? buildDefaults.wasiSdkVersion}/${asset}`, curl);
    wasi = verifyWasiSdk(wasiRoot, manifest);
  }
  if (!wasi.valid) {
    console.error(wasi.diagnostics.join('\n'));
    return 1;
  }

  const work = await mkdtemp(join(tmpdir(), 'wicro-llvm-wasm-'));
  try {
    const source = await cloneAndPatchSource(work, manifest, revisions, buildEnv, jobs);
    if (!cmake || !ninja) throw new Error('CMake and Ninja are required to compile LLVM source.');
    if (!clang || !cxx) throw new Error('A native host C/C++ compiler is required to build LLVM TableGen utilities.');
    const llvmBinary = await compileSource(work, output, manifest, { jobs, llvmTargets, offline: options.offline, force: options.force }, buildEnv, { cmake, ninja, clang, cxx }, wasi);

    await mkdir(output, { recursive: true });
    const candidate = join(work, 'llvm.wasm');
    await cp(llvmBinary, candidate);
    const validation = await validateWasmArtifact(work, manifest);
    if (!validation.valid) {
      console.error(validation.diagnostics.join('\n'));
      return 1;
    }
    if (cache.llvmStatus === 'verified' && !validation.verified) {
      console.error(validation.diagnostics.join('\n'));
      console.error('The verified llvm.wasm cache was preserved because this replacement is not SHA-256-verified yet. Existing compilation, linking, and firmware tests must pass before publishing it.');
      return 2;
    }

    await cp(candidate, join(output, 'llvm.wasm'));
    await updateUnifiedManifest(output, manifest);
    console.log(JSON.stringify({ cache: validation.verified ? 'verified' : 'candidate', llvmWasm: join(output, 'llvm.wasm'), sha256: validation.wasm, source: revisions, wasiSdk: manifest.revisions?.['wasi-sdk'] ?? buildDefaults.wasiSdkVersion }, null, 2));
    return validation.verified ? 0 : 3;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
