import { WASI, OpenFile, File, Directory, PreopenDirectory, ConsoleStdout } from '@bjorn3/browser_wasi_shim';
import { resolveArchitectureTargetArgs } from '../../core/src/platform/architectures.js';

/**
 * Insert a file into a nested Map tree for `@bjorn3/browser_wasi_shim` PreopenDirectory.
 * @param {Map<string, any>} rootMap
 * @param {string} relativePath
 * @param {Uint8Array} bytes
 */
const putVirtualFile = (rootMap, relativePath, bytes) => {
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
  current.set(parts[parts.length - 1], new File(bytes));
};

/**
 * Browser-compatible WASI LLVM/LLD toolchain adapter using `@bjorn3/browser_wasi_shim`.
 * Zero Node.js imports — works identically in browsers, Web Workers, and Node.js.
 */
export class BrowserLlvmWasmToolchain {
  /** @param {{loadModule: () => Promise<WebAssembly.Module>}} options */
  constructor(options) {
    if (typeof options?.loadModule !== 'function') {
      throw new Error('BrowserLlvmWasmToolchain requires a loadModule() function');
    }
    this.loadModule = options.loadModule;
  }

  /**
   * @param {string[]} args
   * @param {Map<string, any>} tmpFiles
   */
  async runWasi(args, tmpFiles) {
    const module = await this.loadModule();
    const tmpDir = new PreopenDirectory('/tmp', tmpFiles);
    let stdout = '';
    let stderr = '';
    const wasi = new WASI(args, [], [
      new OpenFile(new File([])),
      ConsoleStdout.lineBuffered((line) => { stdout += `${line}\n`; }),
      ConsoleStdout.lineBuffered((line) => { stderr += `${line}\n`; }),
      tmpDir
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
   * @param {{language?:'c'|'c++'|'assembly',includeDirs?:string[],compilerFlags?:string[],defines?:string[],files?:Record<string,string|Uint8Array>}} [options]
   */
  async compileSource(source, target = 'riscv32', targetOptions = {}, options = {}) {
    const language = options.language ?? 'c';
    const extension = language === 'c++' ? 'cpp' : language === 'assembly' ? 's' : 'c';
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

    const result = await this.runWasi(args, tmpFiles);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || `Compiler exited with status ${result.exitCode}`);
    }
    const objectEntry = result.tmpDir.dir.contents.get('main.o');
    if (!(objectEntry instanceof File) || objectEntry.data.byteLength === 0) {
      throw new Error('Browser WASI compiler did not produce main.o');
    }
    return {
      object: new Uint8Array(objectEntry.data),
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
   * @param {{objects:Record<string,Uint8Array>,preObjects?:Record<string,Uint8Array>,archives?:Record<string,Uint8Array>,linkerScripts?:Record<string,string|Uint8Array>,undefinedSymbols?:string[],extraLinkerArgs?:string[],entry?:string,target:string}} options
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

    const args = [
      'ld.lld',
      '--gc-sections',
      '-EL',
      ...(options.extraLinkerArgs ?? []),
      ...(options.entry ? ['-e', options.entry] : []),
      ...(options.undefinedSymbols?.flatMap((symbol) => ['-u', symbol]) ?? []),
      ...scriptArgs,
      ...preObjectArgs,
      '--start-group',
      ...objectArgs,
      ...archiveArgs,
      '--end-group',
      '-o',
      '/tmp/firmware.elf'
    ];

    const result = await this.runWasi(args, tmpFiles);
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
