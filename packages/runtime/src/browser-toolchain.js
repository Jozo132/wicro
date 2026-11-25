import { WASI, OpenFile, File, Directory, PreopenDirectory, ConsoleStdout } from '@bjorn3/browser_wasi_shim';
import { resolveArchitectureTargetArgs } from '../../core/src/platform/architectures.js';
import { parseClangDiagnostics, parseCodeCompletion, sha256Digest } from './elf-utils.js';

/**
 * Insert a file into a nested Map tree for `@bjorn3/browser_wasi_shim` PreopenDirectory.
 * @param {Map<string, any>} rootMap
 * @param {string} relativePath
 * @param {Uint8Array} bytes
 */
export const putVirtualFile = (rootMap, relativePath, bytes) => {
  const parts = relativePath.replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter(Boolean);
  if (parts.length === 0) return;
  let current = rootMap;
  for (let index = 0; index < parts.length - 1; index++) {
    const segment = parts[index];
    let next = current.get(segment);
    if (!(next instanceof Directory)) {
      next = new Directory(new Map());
      current.set(segment, next);
    }
    current = next.contents;
  }
  current.set(parts[parts.length - 1], new File(bytes, { readonly: true }));
};

/**
 * Build a reusable `@bjorn3/browser_wasi_shim` directory map from path -> bytes entries.
 * @param {Iterable<[string, Uint8Array|string]>} entries
 * @returns {Map<string, any>}
 */
export const buildWasiDirectoryMap = (entries) => {
  const rootMap = new Map();
  const encoder = new TextEncoder();
  for (const [path, data] of entries) {
    putVirtualFile(rootMap, path, typeof data === 'string' ? encoder.encode(data) : data);
  }
  return rootMap;
};

/**
 * Compute a hex SHA-256 cache key for incremental object compilation.
 * @param {string} text
 * @returns {Promise<string>}
 */
const hashKey = async (text) => {
  const digest = await sha256Digest(new TextEncoder().encode(text));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * Browser-compatible WASI LLVM/LLD toolchain adapter using `@bjorn3/browser_wasi_shim`.
 * Zero Node.js imports — works identically in browsers, Web Workers, and Node.js.
 */
export class BrowserLlvmWasmToolchain {
  /**
   * @param {{
   *   loadModule: () => Promise<WebAssembly.Module>,
   *   loadLinkerModule?: () => Promise<WebAssembly.Module>,
   *   resolvePreopen?: (virtualPath: string, hostPath: string) => Promise<Map<string, any>|undefined>,
   *   objectCache?: Map<string, Uint8Array>
   * }} options
   */
  constructor(options) {
    if (typeof options?.loadModule !== 'function') {
      throw new Error('BrowserLlvmWasmToolchain requires a loadModule() function');
    }
    this.loadModule = options.loadModule;
    this.loadLinkerModule = options.loadLinkerModule ?? options.loadModule;
    this.resolvePreopen = options.resolvePreopen;
    /** @type {Map<string, Uint8Array>} */
    this.objectCache = options.objectCache ?? new Map();
  }

  /**
   * @param {string[]} args
   * @param {Map<string, any>} tmpFiles
   * @param {{preopens?: Record<string, string>, useLinker?: boolean}} [options]
   */
  async runWasi(args, tmpFiles, options = {}) {
    const module = await (options.useLinker ? this.loadLinkerModule() : this.loadModule());
    const tmpDir = new PreopenDirectory('/tmp', tmpFiles);
    /** @type {any[]} */
    const extraPreopens = [];
    if (options.preopens && this.resolvePreopen) {
      for (const [virtualPath, hostPath] of Object.entries(options.preopens)) {
        const dirMap = await this.resolvePreopen(virtualPath, hostPath);
        if (dirMap) extraPreopens.push(new PreopenDirectory(virtualPath, dirMap));
      }
    }

    let stdout = '';
    let stderr = '';
    const wasi = new WASI(args, [], [
      new OpenFile(new File([])),
      ConsoleStdout.lineBuffered((line) => { stdout += `${line}\n`; }),
      ConsoleStdout.lineBuffered((line) => { stderr += `${line}\n`; }),
      tmpDir,
      ...extraPreopens
    ]);
    const instance = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: wasi.wasiImport
    });
    const exitCode = wasi.start(/** @type {any} */ (instance));
    return { exitCode, stdout, stderr, tmpDir };
  }

  /**
   * @param {string} source
   * @param {string} [target]
   * @param {{march?:string,mabi?:string,mcpu?:string,mcu?:string}} [targetOptions]
   * @param {{language?:'c'|'c++'|'assembly',includeDirs?:string[],compilerFlags?:string[],defines?:string[],files?:Record<string,string|Uint8Array>,preopens?:Record<string,string>,cacheDirectory?:string}} [options]
   */
  async compileSource(source, target = 'riscv32', targetOptions = {}, options = {}) {
    const language = options.language ?? 'c';
    const extension = language === 'c++' ? 'cpp' : language === 'assembly' ? 's' : 'c';

    const cacheKey = await hashKey(JSON.stringify({
      source,
      target,
      targetOptions,
      language,
      includeDirs: options.includeDirs ?? [],
      compilerFlags: options.compilerFlags ?? [],
      defines: options.defines ?? [],
      preopens: options.preopens ?? {},
      files: await Promise.all(Object.entries(options.files ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(async ([name, data]) => [name, typeof data === 'string' ? await hashKey(data) : [...await sha256Digest(data)].map((byte) => byte.toString(16).padStart(2, '0')).join('')]))
    }));

    const cached = this.objectCache.get(cacheKey);
    if (cached) {
      return {
        object: new Uint8Array(cached),
        target,
        cache: 'hit',
        diagnostics: []
      };
    }

    const tmpFiles = new Map();
    const encoder = new TextEncoder();
    putVirtualFile(tmpFiles, `main.${extension}`, encoder.encode(source));

    for (const [name, data] of Object.entries(options.files ?? {})) {
      if (name.includes('..') || name.startsWith('/')) throw new Error(`Unsafe include path: ${name}`);
      putVirtualFile(tmpFiles, name, typeof data === 'string' ? encoder.encode(data) : data);
    }

    const args = [
      'clang',
      ...resolveArchitectureTargetArgs(target, targetOptions),
      ...(language === 'c++' ? ['-x', 'c++'] : language === 'assembly' ? ['-x', 'assembler'] : []),
      ...(options.includeDirs ?? []).flatMap((dir) => ['-I', dir.startsWith('/') ? dir : `/tmp/${dir}`]),
      ...(options.compilerFlags ?? []),
      ...(options.defines ?? []).flatMap((define) => ['-D', define]),
      '-nostdlib',
      '-c',
      `/tmp/main.${extension}`,
      '-o',
      '/tmp/main.o'
    ];

    const result = await this.runWasi(args, tmpFiles, { preopens: options.preopens });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || `Compiler exited with status ${result.exitCode}`);
    }
    const objectEntry = result.tmpDir.dir.contents.get('main.o');
    if (!(objectEntry instanceof File) || objectEntry.data.byteLength === 0) {
      throw new Error('Browser WASI compiler did not produce main.o');
    }
    const object = new Uint8Array(objectEntry.data);
    this.objectCache.set(cacheKey, new Uint8Array(object));
    return {
      object,
      target,
      cache: 'miss',
      diagnostics: result.stderr ? [result.stderr] : []
    };
  }

  /** @param {string} source @param {string} [target] @param {{march?:string,mabi?:string,mcpu?:string,mcu?:string}} [targetOptions] */
  async compileC(source, target = 'riscv32', targetOptions = {}) {
    return this.compileSource(source, target, targetOptions, { language: 'c' });
  }

  /**
   * Link ELF32 firmware entirely in-memory via browser WASI `ld.lld`.
   * Supports both staged object/archive buffers and `/sdk` preopen paths.
   * @param {{objects:Record<string,Uint8Array>,preObjects?:Record<string,Uint8Array>,archives?:Record<string,Uint8Array>,archivePaths?:string[],linkerScripts?:Record<string,string|Uint8Array>,linkerScriptPaths?:string[],libraryPaths?:string[],libraries?:string[],undefinedSymbols?:string[],extraLinkerArgs?:string[],emitBinary?:boolean,entry?:string,preopens?:Record<string,string>,target:string}} options
   */
  async linkElf(options) {
    const tmpFiles = new Map();
    const encoder = new TextEncoder();

    /** @type {string[]} */
    const preObjectArgs = [];
    for (const [name, data] of Object.entries(options.preObjects ?? {})) {
      putVirtualFile(tmpFiles, name, data);
      preObjectArgs.push(`/tmp/${name}`);
    }

    /** @type {string[]} */
    const objectArgs = [];
    for (const [name, data] of Object.entries(options.objects)) {
      putVirtualFile(tmpFiles, name, data);
      objectArgs.push(`/tmp/${name}`);
    }

    /** @type {string[]} */
    const archiveArgs = [];
    for (const [name, data] of Object.entries(options.archives ?? {})) {
      putVirtualFile(tmpFiles, name, data);
      archiveArgs.push(`/tmp/${name}`);
    }

    /** @type {string[]} */
    const scriptArgs = [];
    for (const [name, script] of Object.entries(options.linkerScripts ?? {})) {
      putVirtualFile(tmpFiles, name, typeof script === 'string' ? encoder.encode(script) : script);
      scriptArgs.push('-T', `/tmp/${name}`);
    }
    for (const scriptPath of options.linkerScriptPaths ?? []) {
      scriptArgs.push('-T', scriptPath);
    }

    const args = [
      'ld.lld',
      '--gc-sections',
      '-EL',
      ...(options.extraLinkerArgs ?? []),
      ...(options.entry ? ['-e', options.entry] : []),
      ...(options.undefinedSymbols?.flatMap((symbol) => ['-u', symbol]) ?? []),
      ...(options.libraryPaths?.flatMap((libraryPath) => ['-L', libraryPath.startsWith('/') ? libraryPath : `/tmp/${libraryPath}`]) ?? []),
      ...scriptArgs,
      ...preObjectArgs,
      '--start-group',
      ...objectArgs,
      ...archiveArgs,
      ...(options.archivePaths ?? []),
      '--end-group',
      ...(options.libraries?.flatMap((library) => ['-l', library]) ?? []),
      '-o',
      '/tmp/firmware.elf'
    ];

    const result = await this.runWasi(args, tmpFiles, { preopens: options.preopens, useLinker: true });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || `Linker exited with status ${result.exitCode}`);
    }
    const elfEntry = result.tmpDir.dir.contents.get('firmware.elf');
    if (!(elfEntry instanceof File) || elfEntry.data.byteLength < 52) {
      throw new Error('Browser WASI linker did not produce a valid ELF32 image');
    }
    const elf = new Uint8Array(elfEntry.data);
    return {
      elf,
      bin: new Uint8Array(0),
      target: options.target,
      diagnostics: result.stderr ? [result.stderr] : []
    };
  }

  /**
   * Syntax-check source code with Clang and return structured diagnostics.
   * @param {{source:string,target?:string,targetOptions?:{march?:string,mabi?:string,mcpu?:string,mcu?:string},language?:'c'|'c++',includeDirs?:string[],compilerFlags?:string[],defines?:string[],files?:Record<string,string|Uint8Array>,preopens?:Record<string,string>}} options
   */
  async diagnoseSource(options) {
    const language = options.language ?? 'c++';
    const extension = language === 'c++' ? 'cpp' : 'c';
    const tmpFiles = new Map();
    const encoder = new TextEncoder();
    putVirtualFile(tmpFiles, `main.${extension}`, encoder.encode(options.source));
    for (const [name, data] of Object.entries(options.files ?? {})) {
      if (name.includes('..') || name.startsWith('/')) continue;
      putVirtualFile(tmpFiles, name, typeof data === 'string' ? encoder.encode(data) : data);
    }

    const args = [
      'clang',
      ...resolveArchitectureTargetArgs(options.target ?? 'riscv32', options.targetOptions ?? {}),
      ...(language === 'c++' ? ['-x', 'c++'] : []),
      ...(options.includeDirs ?? []).flatMap((dir) => ['-I', dir.startsWith('/') ? dir : `/tmp/${dir}`]),
      ...(options.compilerFlags ?? []),
      ...(options.defines ?? []).flatMap((define) => ['-D', define]),
      '-nostdlib',
      '-fsyntax-only',
      `/tmp/main.${extension}`
    ];

    const result = await this.runWasi(args, tmpFiles, { preopens: options.preopens });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      diagnostics: parseClangDiagnostics(result.stderr)
    };
  }

  /**
   * Request Clang code completions at a 1-based line and column.
   * @param {{source:string,target?:string,targetOptions?:{march?:string,mabi?:string,mcpu?:string,mcu?:string},language?:'c'|'c++',includeDirs?:string[],defines?:string[],files?:Record<string,string|Uint8Array>,preopens?:Record<string,string>,line:number,column:number}} options
   */
  async completeSource(options) {
    const language = options.language ?? 'c++';
    const extension = language === 'c++' ? 'cpp' : 'c';
    const tmpFiles = new Map();
    putVirtualFile(tmpFiles, `main.${extension}`, new TextEncoder().encode(options.source));
    for (const [path, bytes] of Object.entries(options.files ?? {})) putVirtualFile(tmpFiles, path, typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);

    const args = [
      'clang',
      ...resolveArchitectureTargetArgs(options.target ?? 'riscv32', options.targetOptions ?? {}),
      ...(language === 'c++' ? ['-x', 'c++'] : []),
      ...(options.includeDirs ?? []).flatMap((dir) => ['-I', dir.startsWith('/') ? dir : `/tmp/${dir}`]),
      ...(options.defines ?? []).flatMap((define) => ['-D', define]),
      '-nostdlib',
      '-fsyntax-only',
      '-Xclang',
      `-code-completion-at=/tmp/main.${extension}:${options.line}:${options.column}`,
      `/tmp/main.${extension}`
    ];

    const result = await this.runWasi(args, tmpFiles, { preopens: options.preopens });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      candidates: parseCodeCompletion(result.stderr || result.stdout)
    };
  }

  clearObjectCache() {
    this.objectCache.clear();
  }

  async targets() {
    const result = await this.runWasi(['clang', '--print-targets'], new Map());
    if (result.exitCode !== 0) throw new Error(result.stderr || 'Unable to list LLVM targets');
    const targets = [];
    if (/^\s*arm\s+-/mi.test(result.stdout)) targets.push('armv7-m', 'armv7e-m');
    if (/avr/i.test(result.stdout)) targets.push('avr');
    if (/riscv32/i.test(result.stdout)) targets.push('riscv32');
    if (/riscv64/i.test(result.stdout)) targets.push('riscv64');
    if (/xtensa/i.test(result.stdout)) targets.push('xtensa');
    return targets;
  }
}
