import { assemblyPipeline } from './assembly-pipeline.js';
export { elfToEsp8266Bin, validateEsp8266Image } from './esp8266-image.js';
import { WASI } from 'node:wasi';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import {
  elfToBin as sharedElfToBin,
  elfToEsp32Bin as sharedElfToEsp32Bin,
  extractArchiveMember,
  inspectElfMemoryStats,
  parseClangDiagnostics,
  parseCodeCompletion,
  patchElfSectionFlags,
  validateEsp32Image
} from './elf-utils.js';

export {
  extractArchiveMember,
  inspectElfMemoryStats,
  parseClangDiagnostics,
  parseCodeCompletion,
  patchElfSectionFlags,
  validateEsp32Image,
  sharedElfToEsp32Bin as elfToEsp32Bin,
  sharedElfToBin as elfToBin
};

/** @typedef {object} WasiRunOptions @property {string[]} [args] @property {Record<string,string>} [env] @property {Record<string,string>} [preopens] @property {boolean} [returnOnExit] */

/** @typedef {object} WasiRunResult @property {number} exitCode @property {string} stdout @property {string} stderr */
/** @typedef {object} BrowserWasi @property {{[key:string]: (...args: any[]) => unknown}} wasiImport @property {(instance: WebAssembly.Instance) => void} initialize */

export class NodeWasiRunner {
  /** @param {{stdout?: (text:string)=>void, stderr?: (text:string)=>void}} [callbacks] */
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    /** @type {Map<string, WebAssembly.Module>} */
    this.moduleCache = new Map();
  }

  /**
   * @param {Uint8Array|string} wasm
   * @param {WasiRunOptions} [options]
   * @returns {Promise<WasiRunResult>}
   */
  async run(wasm, options = {}) {
    const captureDirectory = await mkdtemp(join(tmpdir(), 'wicro-wasi-'));
    const stdoutPath = join(captureDirectory, 'stdout.txt');
    const stderrPath = join(captureDirectory, 'stderr.txt');
    const stdoutFd = openSync(stdoutPath, 'w+');
    const stderrFd = openSync(stderrPath, 'w+');

    const wasi = new WASI({
      version: 'preview1',
      args: options.args ?? [],
      env: options.env ?? {},
      preopens: options.preopens ?? {},
      returnOnExit: options.returnOnExit ?? true,
      stdout: stdoutFd,
      stderr: stderrFd
    });

    /** @type {WebAssembly.Module} */
    let module;
    if (typeof wasm === 'string') {
      const cached = this.moduleCache.get(wasm);
      if (cached) {
        module = cached;
      } else {
        const bytes = await readFile(wasm);
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        module = await WebAssembly.compile(copy);
        this.moduleCache.set(wasm, module);
      }
    } else {
      const copy = new Uint8Array(wasm.byteLength);
      copy.set(wasm);
      module = await WebAssembly.compile(copy);
    }

    // Wrap WASI imports in plain JS functions to prevent Node.js V8 FastCallback
    // crashes when uvwasi external-memory accounting triggers GC inside path_open.
    const safeWasiImport = Object.fromEntries(
      Object.entries(wasi.wasiImport).map(([name, value]) => [
        name,
        typeof value === 'function' ? (/** @type {unknown[]} */ ...args) => /** @type {(...a: unknown[]) => unknown} */ (value)(...args) : value
      ])
    );

    const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: safeWasiImport });
    let exitCode = 0;

    try {
      const result = wasi.start(instance);
      if (typeof result === 'number') exitCode = result;
    } catch (error) {
      if (error && typeof error === 'object' && 'exitCode' in error) {
        exitCode = Number(error.exitCode);
      } else {
        throw error;
      }
    }

    closeSync(stdoutFd);
    closeSync(stderrFd);
    const [capturedStdout, capturedStderr] = await Promise.all([
      readFile(stdoutPath, 'utf8'),
      readFile(stderrPath, 'utf8')
    ]);
    await rm(captureDirectory, { recursive: true, force: true });

    return { exitCode, stdout: capturedStdout, stderr: capturedStderr };
  }
}

/** Browser WASI contract. Implementations host memory and OPFS through the Fd interface. */
export class LlvmWasmToolchain {
  /** @param {{llvmPath:string,linkerPath?:string,runner?:NodeWasiRunner}} options */
  constructor(options) {
    this.llvmPath = options.llvmPath;
    this.linkerPath = options.linkerPath;
    this.runner = options.runner ?? new NodeWasiRunner();
  }

  /** @param {string} target @param {{march?:string,mabi?:string,mcpu?:string,mcu?:string}} [targetOptions] */
  targetArgs(target, targetOptions = {}) {
    if (target === 'armv6m') {
      return [
        '--target=arm-none-eabi',
        `-mcpu=${targetOptions.mcpu ?? 'cortex-m0plus'}`,
        '-mthumb'
      ];
    }

    if (target === 'armv7-m') {
      return [
        '--target=arm-none-eabi',
        `-mcpu=${targetOptions.mcpu ?? 'cortex-m3'}`,
        '-mthumb',
        '-mfloat-abi=soft'
      ];
    }

    if (target === 'armv7e-m') {
      return [
        '--target=arm-none-eabi',
        `-mcpu=${targetOptions.mcpu ?? 'cortex-m4'}`,
        '-mthumb',
        '-mfloat-abi=hard'
      ];
    }

    if (target === 'armv8m-mainline') {
      return [
        '--target=arm-none-eabi',
        `-mcpu=${targetOptions.mcpu ?? 'cortex-m33'}`,
        '-mthumb',
        '-mfloat-abi=hard'
      ];
    }

    if (target === 'avr') {
      return [
        '--target=avr',
        `-mmcu=${targetOptions.mcu ?? 'atmega328p'}`
      ];
    }

    if (target === 'riscv32') {
      return [
        '--target=riscv32-esp-elf',
        `-march=${targetOptions.march ?? 'rv32imc'}`,
        `-mabi=${targetOptions.mabi ?? 'ilp32'}`
      ];
    }

    if (target === 'riscv64') {
      return [
        '--target=riscv64-unknown-elf',
        `-march=${targetOptions.march ?? 'rv64gc'}`,
        `-mabi=${targetOptions.mabi ?? 'lp64d'}`
      ];
    }

    if (target === 'xtensa') {
      return [
        '--target=xtensa-esp-elf',
        `-mcpu=${targetOptions.mcpu ?? 'esp32'}`
      ];
    }

    throw new Error(`Unsupported LLVM target: ${target}`);
  }

/**
 * Compile C, C++, or assembly source with the shared LLVM WASM compiler.
 * @param {string} source
 * @param {string} target
 * @param {{march?:string,mabi?:string,mcpu?:string,mcu?:string}} [targetOptions]
 * @param {{language?:'c'|'c++'|'assembly',includeDirs?:string[],compilerFlags?:string[],defines?:string[],compilerHash?:string,compilerVersion?:string,cacheDirectory?:string,files?:Record<string,string|Uint8Array>,preopens?:Record<string,string>,diagnostics?:string[]}} [options]
 */
  async compileSource(source, target = 'riscv32', targetOptions = {}, options = {}) {
    const language = options.language ?? 'c';
    const extension = language === 'c++' ? 'cpp' : language === 'assembly' ? 's' : 'c';
    const directory = await mkdtemp(join(tmpdir(), 'wicro-llvm-'));

    try {
      await writeFile(join(directory, `main.${extension}`), source);
      for (const [name, data] of Object.entries(options.files ?? {})) {
        if (name.includes('..') || name.startsWith('/')) throw new Error(`Unsafe include file path: ${name}`);
        const path = join(directory, name);
        await mkdir(join(directory, name).slice(0, join(directory, name).lastIndexOf('/')), { recursive: true });
        await writeFile(path, data);
      }

      const cacheKey = createHash('sha256').update(JSON.stringify({
        source,
        target,
        targetOptions,
        language,
        includeDirs: options.includeDirs ?? [],
        compilerFlags: options.compilerFlags ?? [],
        defines: options.defines ?? [],
        compilerHash: options.compilerHash ?? '32a1fb128050002a4e2c8797c4730fbd08bdb6c6991c204645d92aec85b212d4',
        compilerVersion: options.compilerVersion ?? '202611141634-v6.0.3',
        files: Object.fromEntries(Object.entries(options.files ?? {}).map(([name, data]) => [name, typeof data === 'string' ? data : createHash('sha256').update(data).digest('hex')]))
      })).digest('hex');
      const cacheDirectory = options.cacheDirectory;
      const cachedObject = cacheDirectory ? join(cacheDirectory, `${cacheKey}.o`) : undefined;

      if (cachedObject) {
        try {
          const object = await readFile(cachedObject);
          return { object, target, cache: 'hit', diagnostics: options.diagnostics ?? [] };
        } catch {
          // Compile on a cache miss.
        }
      }

      const args = [
        'clang',
        ...this.targetArgs(target, targetOptions),
        ...(language === 'c++' ? ['-x', 'c++'] : language === 'assembly' ? ['-x', 'assembler'] : []),
        ...(options.includeDirs ?? []).flatMap((directoryName) => ['-I', /^\//.test(directoryName) ? directoryName : /^sdk\//.test(directoryName) ? (options.preopens?.['/sdk'] ? `/${directoryName}` : `/tmp/${directoryName}`) : `/tmp/${directoryName}`]),
        ...(options.compilerFlags ?? []),
        ...(options.defines ?? []).flatMap((define) => ['-D', define]),
        '-nostdlib',
        '-c',
        `/tmp/main.${extension}`,
        '-o',
        '/tmp/main.o'
      ];
      const preopens = { '/tmp': directory, ...(options.preopens ?? {}) };
      const pipeline = assemblyPipeline(args, language);
      if (pipeline.preprocess) {
        const preprocessed = await this.runner.run(this.llvmPath, { args: pipeline.preprocess, preopens });
        if (preprocessed.exitCode !== 0) throw new Error(preprocessed.stderr || preprocessed.stdout || 'WASM assembly preprocessing failed');
      }
      const result = await this.runner.run(this.llvmPath, {
        args: pipeline.compile,
        preopens
      });

      if (result.exitCode !== 0) {
        throw new Error(result.stderr || result.stdout || `Compiler exited with status ${result.exitCode}`);
      }

      const object = await readFile(join(directory, 'main.o'));
      if (cachedObject) {
        await mkdir(/** @type {string} */ (cacheDirectory), { recursive: true });
        await writeFile(cachedObject, object);
      }
      return { object, target, cache: 'miss', diagnostics: result.stderr ? [result.stderr] : (options.diagnostics ?? []) };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /** @param {string} source @param {string} target @param {{march?:string,mabi?:string,mcpu?:string,mcu?:string}} [targetOptions] */
  async compileC(source, target = 'riscv32', targetOptions = {}) {
    return this.compileSource(source, target, targetOptions, { language: 'c' });
  }

  /**
   * Run real clang syntax/semantic diagnostics through WASI.
   * @param {{source:string,target?:string,targetOptions?:{march?:string,mabi?:string,mcpu?:string,mcu?:string},language?:'c'|'c++',includeDirs?:string[],files?:Record<string,string|Uint8Array>,defines?:string[],unsaved?:Record<string,string>}} options
   */
  async diagnoseSource(options) {
    const directory = await mkdtemp(join(tmpdir(), 'wicro-diagnostics-'));
    const language = options.language ?? 'c';
    const extension = language === 'c++' ? 'cpp' : 'c';

    try {
      await writeFile(join(directory, `main.${extension}`), options.unsaved?.['main.' + extension] ?? options.source);
      for (const [name, data] of Object.entries(options.files ?? {})) {
        if (name.includes('..') || name.startsWith('/')) throw new Error(`Unsafe source file path: ${name}`);
        const path = join(directory, name);
        await mkdir(join(directory, name).slice(0, join(directory, name).lastIndexOf('/')), { recursive: true });
        await writeFile(path, data);
      }
      for (const [name, data] of Object.entries(options.unsaved ?? {})) {
        if (name.includes('..') || name.startsWith('/')) throw new Error(`Unsafe unsaved file path: ${name}`);
        const path = join(directory, name);
        await mkdir(join(directory, name).slice(0, join(directory, name).lastIndexOf('/')), { recursive: true });
        await writeFile(path, data);
      }

      const result = await this.runner.run(this.llvmPath, {
        args: [
          'clang',
          ...this.targetArgs(options.target ?? 'riscv32', options.targetOptions),
          ...(language === 'c++' ? ['-x', 'c++'] : []),
          ...((options.includeDirs ?? []).flatMap((directoryName) => ['-I', `/tmp/${directoryName}`])),
          ...(options.defines ?? []).flatMap((define) => ['-D', define]),
          '-nostdlib',
          '-fsyntax-only',
          `/tmp/main.${extension}`
        ],
        preopens: { '/tmp': directory }
      });

      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        diagnostics: parseClangDiagnostics(result.stderr)
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /**
   * Ask clang for code-completion candidates at a source position.
   * @param {{source:string,target?:string,targetOptions?:{march?:string,mabi?:string,mcpu?:string,mcu?:string},language?:'c'|'c++',line:number,column:number,includeDirs?:string[],files?:Record<string,string|Uint8Array>,defines?:string[]}} options
   */
  async completeSource(options) {
    const directory = await mkdtemp(join(tmpdir(), 'wicro-completion-'));
    const language = options.language ?? 'c';
    const extension = language === 'c++' ? 'cpp' : 'c';

    try {
      await writeFile(join(directory, `main.${extension}`), options.source);
      for (const [name, data] of Object.entries(options.files ?? {})) {
        if (name.includes('..') || name.startsWith('/')) throw new Error(`Unsafe include file path: ${name}`);
        const path = join(directory, name);
        await mkdir(join(directory, name).slice(0, join(directory, name).lastIndexOf('/')), { recursive: true });
        await writeFile(path, data);
      }

      const result = await this.runner.run(this.llvmPath, {
        args: [
          'clang',
          ...this.targetArgs(options.target ?? 'riscv32', options.targetOptions),
          ...(language === 'c++' ? ['-x', 'c++'] : []),
          ...((options.includeDirs ?? []).flatMap((directoryName) => ['-I', `/tmp/${directoryName}`])),
          ...(options.defines ?? []).flatMap((define) => ['-D', define]),
          '-nostdlib',
          '-fsyntax-only',
          `-Xclang`,
          `-code-completion-at=/tmp/main.${extension}:${options.line}:${options.column}`,
          `/tmp/main.${extension}`
        ],
        preopens: { '/tmp': directory }
      });

      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, candidates: parseCodeCompletion(result.stderr || result.stdout) };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /**
   * Dispatch a tool entry point in the unified or separate WASM distribution.
   * @param {{tool:'clang-format'|'clang-tidy',toolPath:string,source:string,language?:'c'|'c++',arguments?:string[],files?:Record<string,string|Uint8Array>,target?:string,targetOptions?:{march?:string,mabi?:string,mcpu?:string,mcu?:string}}} options
   */
  async runLanguageTool(options) {
    const directory = await mkdtemp(join(tmpdir(), 'wicro-language-tool-'));
    const language = options.language ?? 'c';
    const extension = language === 'c++' ? 'cpp' : 'c';

    try {
      await writeFile(join(directory, `main.${extension}`), options.source);
      for (const [name, data] of Object.entries(options.files ?? {})) {
        if (name.includes('..') || name.startsWith('/')) throw new Error(`Unsafe source file path: ${name}`);
        const path = join(directory, name);
        await mkdir(join(directory, name).slice(0, join(directory, name).lastIndexOf('/')), { recursive: true });
        await writeFile(path, data);
      }

      const result = await this.runner.run(options.toolPath, {
        args: [
          options.tool,
          ...options.arguments ?? [],
          `/tmp/main.${extension}`
        ],
        preopens: { '/tmp': directory }
      });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /**
   * Compile a bare-metal main and C startup source, then link a complete ELF.
   * @param {{source:string,startupSource:string,linkerScript:string,target:string,targetOptions?:{march?:string,mabi?:string,mcpu?:string,mcu?:string},language?:'c'|'c++'}} options
   */
  async compileAndLinkBareMetal(options) {
    const directory = await mkdtemp(join(tmpdir(), 'wicro-bare-metal-'));

    try {
      const language = options.language ?? 'c';
      const sourceName = language === 'c++' ? 'main.cpp' : 'main.c';
      await writeFile(join(directory, sourceName), options.source);
      await writeFile(join(directory, 'startup.c'), options.startupSource);
      await writeFile(join(directory, 'firmware.ld'), options.linkerScript);

      const files = [
        [sourceName, 'main.o'],
        ['startup.c', 'startup.o']
      ];
      const diagnostics = [];

      for (const [sourceName, objectName] of files) {
        const result = await this.runner.run(this.llvmPath, {
          args: [
            'clang',
            ...this.targetArgs(options.target, options.targetOptions),
            '-nostdlib',
            '-ffreestanding',
            ...(language === 'c++' && sourceName.endsWith('.cpp') ? ['-x', 'c++'] : []),
            '-c',
            `/tmp/${sourceName}`,
            '-o',
            `/tmp/${objectName}`
          ],
          preopens: { '/tmp': directory }
        });

        if (result.exitCode !== 0) {
          throw new Error(result.stderr || result.stdout || `Compiler exited with status ${result.exitCode}`);
        }
        if (result.stderr) diagnostics.push(result.stderr);
      }

      const linked = await this.runner.run(this.llvmPath, {
        args: [
          'ld.lld',
          '-nostdlib',
          '-T',
          '/tmp/firmware.ld',
          '-o',
          '/tmp/blink.elf',
          '/tmp/startup.o',
          '/tmp/main.o'
        ],
        preopens: { '/tmp': directory }
      });

      if (linked.exitCode !== 0) {
        throw new Error(linked.stderr || linked.stdout || `Linker exited with status ${linked.exitCode}`);
      }

      const elf = await readFile(join(directory, 'blink.elf'));
      if (elf.length < 52 || elf.subarray(0, 4).toString('hex') !== '7f454c46') {
        throw new Error('Linked output is not an ELF32 image');
      }

      const bin = await this.elfToBin(elf);
      return { elf, bin, target: options.target, diagnostics };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /**
   * Link explicit object/archive inputs with WASM LLD for any supported target.
   * Prefers file-backed WASI preopens (`archivePaths`, `linkerScriptPaths`, `preopens`)
   * so large SDK archives stay on disk instead of being copied through JS memory.
   * emitBinary:false defers binary conversion to the shared firmware format handler.
   * @param {{objects:Record<string,Uint8Array>|Uint8Array[],preObjects?:Record<string,Uint8Array>,archives?:Record<string,Uint8Array>,archivePaths?:string[],linkerScripts?:Record<string,string|Uint8Array>,linkerScriptPaths?:string[],libraryPaths?:string[],libraries?:string[],undefinedSymbols?:string[],extraLinkerArgs?:string[],emitBinary?:boolean,target:string,targetOptions?:{march?:string,mabi?:string,mcpu?:string,mcu?:string},entry?:string,preopens?:Record<string,string>}} options
   */
  async linkElf(options) {
    const directory = await mkdtemp(join(tmpdir(), 'wicro-elf-link-'));
    try {
      /** @param {string} name @param {Uint8Array|string} data */
      const stageTmp = async (name, data) => {
        if (name.includes('..') || name.startsWith('/')) throw new Error(`Unsafe staged path: ${name}`);
        const targetPath = join(directory, name);
        const parentDir = targetPath.slice(0, targetPath.lastIndexOf('/'));
        if (parentDir) await mkdir(parentDir, { recursive: true });
        await writeFile(targetPath, data);
        return `/tmp/${name}`;
      };

      /** @type {string[]} */
      const preObjectArgs = [];
      for (const [name, data] of Object.entries(options.preObjects ?? {})) {
        preObjectArgs.push(await stageTmp(name, data));
      }

      /** @type {string[]} */
      const objectArgs = [];
      /** @type {[string, Uint8Array][]} */
      const objectEntries = Array.isArray(options.objects)
        ? options.objects.map((data, index) => [`object-${index}.o`, data])
        : Object.entries(options.objects).map(([name, data]) => [name, /** @type {Uint8Array} */ (data)]);
      for (const [name, data] of objectEntries) {
        objectArgs.push(await stageTmp(name, data));
      }

      /** @type {string[]} */
      const stagedArchiveArgs = [];
      for (const [name, data] of Object.entries(options.archives ?? {})) {
        stagedArchiveArgs.push(await stageTmp(name, data));
      }

      /** @type {string[]} */
      const linkerScriptArgs = [];
      for (const [name, script] of Object.entries(options.linkerScripts ?? {})) {
        const stagedPath = await stageTmp(name, script);
        linkerScriptArgs.push('-T', stagedPath);
      }
      for (const scriptPath of options.linkerScriptPaths ?? []) {
        linkerScriptArgs.push('-T', scriptPath);
      }

      const args = [
        'ld.lld',
        '--gc-sections',
        '-EL',
        ...(options.extraLinkerArgs ?? []),
        ...(options.entry ? ['-e', options.entry] : []),
        ...(options.undefinedSymbols?.flatMap((symbol) => ['-u', symbol]) ?? []),
        ...(options.libraryPaths?.flatMap((libraryPath) => ['-L', libraryPath.startsWith('/') ? libraryPath : `/tmp/${libraryPath}`]) ?? []),
        ...linkerScriptArgs,
        ...preObjectArgs,
        '--start-group',
        ...objectArgs,
        ...stagedArchiveArgs,
        ...(options.archivePaths ?? []),
        '--end-group',
        ...(options.libraries?.flatMap((library) => ['-l', library]) ?? []),
        '-o',
        '/tmp/firmware.elf'
      ];

      const linked = await this.runner.run(this.llvmPath, { args, preopens: { '/tmp': directory, ...(options.preopens ?? {}) } });
      if (linked.exitCode !== 0) throw new Error(linked.stderr || linked.stdout || `Linker exited with status ${linked.exitCode}`);

      const elf = await readFile(join(directory, 'firmware.elf'));
      if (elf.length < 52 || elf.subarray(0, 4).toString('hex') !== '7f454c46') throw new Error('Linked output is not an ELF32 image');
      return { elf, bin: options.emitBinary === false ? new Uint8Array(0) : await this.elfToBin(elf), target: options.target, diagnostics: linked.stderr ? [linked.stderr] : [] };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /**
   * Backward-compatible alias for linking ESP32 ELF images through WASM LLD.
   * @param {{objects:Record<string,Uint8Array>|Uint8Array[],preObjects?:Record<string,Uint8Array>,archives?:Record<string,Uint8Array>,archivePaths?:string[],linkerScripts?:Record<string,string|Uint8Array>,linkerScriptPaths?:string[],libraryPaths?:string[],libraries?:string[],undefinedSymbols?:string[],extraLinkerArgs?:string[],emitBinary?:boolean,target:string,targetOptions?:{march?:string,mabi?:string,mcpu?:string,mcu?:string},entry?:string,preopens?:Record<string,string>}} options
   */
  async linkEsp32Elf(options) {
    return this.linkElf(options);
  }

  /**
   * Convert a RISC-V ESP32-C3 ELF32 image into an official Espressif application binary.
   * @param {Uint8Array} elf
   * @returns {Promise<Uint8Array>}
   */
  async elfToEsp32Bin(elf) {
    return sharedElfToEsp32Bin(elf);
  }

  /** @param {Uint8Array} elf @returns {Promise<Uint8Array>} */
  async elfToBin(elf) {
    return sharedElfToBin(elf);
  }

  /** @returns {Promise<string[]>} */
  async targets() {
    const result = await this.runner.run(this.llvmPath, {
      args: ['clang', '--print-targets'],
      preopens: {}
    });

    if (result.exitCode !== 0) throw new Error(result.stderr || 'Unable to list LLVM targets');
    const targets = [];
    if (/^\s*arm\s+-/mi.test(result.stdout)) {
      targets.push('armv7-m');
      targets.push('armv7e-m');
    }
    if (/avr/i.test(result.stdout)) targets.push('avr');
    if (/riscv32/i.test(result.stdout)) targets.push('riscv32');
    if (/riscv64/i.test(result.stdout)) targets.push('riscv64');
    if (/xtensa/i.test(result.stdout)) targets.push('xtensa');
    return targets;
  }
}

export class BrowserWasiAdapter {
  /** @param {BrowserWasi} wasi */
  constructor(wasi) {
    if (!wasi) throw new Error('A browser WASI implementation is required');
    this.wasi = wasi;
  }

  /** @param {{module:WebAssembly.Module,args:string[],files:Record<string,Uint8Array|string>}} input */
  async instantiate(input) {
    const instance = await WebAssembly.instantiate(input.module, {
      wasi_snapshot_preview1: this.wasi.wasiImport
    });
    this.wasi.initialize(instance);
    return instance;
  }
}
