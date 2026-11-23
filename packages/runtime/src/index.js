import { WASI } from 'node:wasi';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

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
      const result = await this.runner.run(this.llvmPath, {
        args,
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

      const bin = this.elfToBin(elf);
      return { elf, bin, target: options.target, diagnostics };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /**
   * Link explicit object/archive inputs with WASM LLD for any supported target.
   * Prefers file-backed WASI preopens (`archivePaths`, `linkerScriptPaths`, `preopens`)
   * so large SDK archives stay on disk instead of being copied through JS memory.
   * @param {{objects:Record<string,Uint8Array>|Uint8Array[],preObjects?:Record<string,Uint8Array>,archives?:Record<string,Uint8Array>,archivePaths?:string[],linkerScripts?:Record<string,string|Uint8Array>,linkerScriptPaths?:string[],libraryPaths?:string[],libraries?:string[],undefinedSymbols?:string[],extraLinkerArgs?:string[],target:string,targetOptions?:{march?:string,mabi?:string,mcpu?:string,mcu?:string},entry?:string,preopens?:Record<string,string>}} options
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
      return { elf, bin: this.elfToBin(elf), target: options.target, diagnostics: linked.stderr ? [linked.stderr] : [] };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /**
   * Backward-compatible alias for linking ESP32 ELF images through WASM LLD.
   * @param {{objects:Record<string,Uint8Array>|Uint8Array[],preObjects?:Record<string,Uint8Array>,archives?:Record<string,Uint8Array>,archivePaths?:string[],linkerScripts?:Record<string,string|Uint8Array>,linkerScriptPaths?:string[],libraryPaths?:string[],libraries?:string[],undefinedSymbols?:string[],extraLinkerArgs?:string[],target:string,targetOptions?:{march?:string,mabi?:string,mcpu?:string,mcu?:string},entry?:string,preopens?:Record<string,string>}} options
   */
  async linkEsp32Elf(options) {
    return this.linkElf(options);
  }

  /**
   * Convert a RISC-V ESP32-C3 ELF32 image into an official Espressif application
   * binary with section-based segment merging, 64 KB MMU page alignment for DROM
   * and IROM segments, RAM segment splitting/zero-padding, app_elf_sha256
   * population, XOR checksum, and appended SHA-256 digest.
   * @param {Uint8Array} elf
   * @returns {Uint8Array}
   */
  elfToEsp32Bin(elf) {
    const view = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
    if (elf.length < 52 || view.getUint32(0, true) !== 0x464c457f) {
      throw new Error('Invalid ELF32 image');
    }
    if (view.getUint32(20, true) !== 1) {
      throw new Error('ESP32 ELF is not a supported ELF version');
    }

    const machine = view.getUint16(18, true);
    if (machine !== 243) throw new Error(`Expected RISC-V ELF, got e_machine=${machine}`);

    const entry = view.getUint32(24, true);
    const sectionOffset = view.getUint32(32, true);
    const sectionEntrySize = view.getUint16(46, true);
    const sectionCount = view.getUint16(48, true);

    /** @type {Array<{addr:number,data:Uint8Array}>} */
    const rawSections = [];
    if (sectionOffset > 0 && sectionEntrySize >= 40 && sectionCount > 0) {
      for (let index = 0; index < sectionCount; index++) {
        const offset = sectionOffset + index * sectionEntrySize;
        if (offset + 40 > elf.length) break;
        const type = view.getUint32(offset + 4, true);
        const flags = view.getUint32(offset + 8, true);
        const addr = view.getUint32(offset + 12, true);
        const fileOffset = view.getUint32(offset + 16, true);
        const size = view.getUint32(offset + 20, true);
        // Include allocated sections with file-backed data (exclude SHT_NOBITS=8).
        if (type === 8 || (flags & 2) === 0 || size === 0 || addr === 0) continue;
        if (fileOffset + size > elf.length) throw new Error(`ELF section ${index} extends beyond the file`);
        rawSections.push({ addr, data: elf.subarray(fileOffset, fileOffset + size) });
      }
    }

    if (rawSections.length === 0) {
      // Fallback to PT_LOAD program headers for minimal synthetic ELFs without section tables.
      const programOffset = view.getUint32(28, true);
      const programEntrySize = view.getUint16(42, true);
      const programCount = view.getUint16(44, true);
      for (let index = 0; index < programCount; index++) {
        const offset = programOffset + index * programEntrySize;
        if (offset + 32 > elf.length) break;
        const type = view.getUint32(offset, true);
        const fileOffset = view.getUint32(offset + 4, true);
        const addr = view.getUint32(offset + 12, true);
        const fileSize = view.getUint32(offset + 16, true);
        if (type !== 1 || fileSize === 0 || addr === 0) continue;
        if (fileOffset + fileSize > elf.length) throw new Error(`ELF segment ${index} extends beyond the file`);
        rawSections.push({ addr, data: elf.subarray(fileOffset, fileOffset + fileSize) });
      }
    }

    if (rawSections.length === 0) throw new Error('ELF image has no loadable ESP32 segments');

    rawSections.sort((left, right) => left.addr - right.addr);

    /** @type {Array<{addr:number,data:Uint8Array}>} */
    const merged = [];
    for (const section of rawSections) {
      const previous = merged[merged.length - 1];
      if (
        previous &&
        section.addr >= previous.addr + previous.data.length &&
        section.addr - (previous.addr + previous.data.length) < 16
      ) {
        const gap = section.addr - (previous.addr + previous.data.length);
        const combined = new Uint8Array(previous.data.length + gap + section.data.length);
        combined.set(previous.data, 0);
        combined.set(section.data, previous.data.length + gap);
        previous.data = combined;
      } else {
        merged.push({ addr: section.addr, data: new Uint8Array(section.data) });
      }
    }

    /** @param {Uint8Array} data */
    const pad4 = (data) => {
      const aligned = (data.length + 3) & ~3;
      if (aligned === data.length) return data;
      const padded = new Uint8Array(aligned);
      padded.set(data);
      return padded;
    };

    /** @param {number} addr */
    const isFlashMapped = (addr) =>
      (addr >= 0x3c000000 && addr < 0x3c800000) ||
      (addr >= 0x42000000 && addr < 0x42800000);

    const flashSegments = merged
      .filter((segment) => isFlashMapped(segment.addr))
      .map((segment) => ({ addr: segment.addr, data: pad4(segment.data) }));
    const ramSegments = merged
      .filter((segment) => !isFlashMapped(segment.addr))
      .map((segment) => ({ addr: segment.addr, data: pad4(segment.data) }));

    // Populate esp_app_desc_t.app_elf_sha256 (offset 0x90) when DROM starts with ESP_APP_DESC_MAGIC_WORD.
    const dromSegment = flashSegments.find((segment) => segment.addr >= 0x3c000000 && segment.addr < 0x3c800000);
    if (dromSegment && dromSegment.data.length >= 0xb0) {
      const dromView = new DataView(dromSegment.data.buffer, dromSegment.data.byteOffset, dromSegment.data.byteLength);
      if (dromView.getUint32(0, true) === 0xabcd5432) {
        const elfSha = createHash('sha256').update(elf).digest();
        dromSegment.data.set(elfSha, 0x90);
      }
    }

    const IROM_ALIGN = 0x10000;
    /** @type {Array<{addr:number,data:Uint8Array}>} */
    const outputSegments = [];
    let filePos = 24;

    /** @param {{addr:number,data:Uint8Array}} segment */
    const emit = (segment) => {
      outputSegments.push(segment);
      filePos += 8 + segment.data.length;
    };

    for (const flashSegment of flashSegments) {
      const targetOffset = flashSegment.addr & (IROM_ALIGN - 1);
      const currentOffset = (filePos + 8) & (IROM_ALIGN - 1);
      let padNeeded = (targetOffset - currentOffset) & (IROM_ALIGN - 1);
      while (padNeeded > 0) {
        if (padNeeded < 8) padNeeded += IROM_ALIGN;
        if (ramSegments.length > 0) {
          const ramSegment = ramSegments[0];
          const totalSize = 8 + ramSegment.data.length;
          if (totalSize <= padNeeded) {
            emit(/** @type {{addr:number,data:Uint8Array}} */ (ramSegments.shift()));
            padNeeded -= totalSize;
            continue;
          }
          const take = (padNeeded - 8) & ~3;
          if (take > 0) {
            emit({ addr: ramSegment.addr, data: ramSegment.data.subarray(0, take) });
            ramSegment.addr += take;
            ramSegment.data = ramSegment.data.subarray(take);
            padNeeded -= (8 + take);
            continue;
          }
        }
        emit({ addr: 0, data: new Uint8Array(padNeeded - 8) });
        padNeeded = 0;
      }
      emit(flashSegment);
    }

    while (ramSegments.length > 0) {
      emit(/** @type {{addr:number,data:Uint8Array}} */ (ramSegments.shift()));
    }

    if (outputSegments.length > 16) throw new Error(`ELF image has too many segments (${outputSegments.length})`);

    const header = new Uint8Array(24);
    const headerView = new DataView(header.buffer);
    header[0] = 0xe9;
    header[1] = outputSegments.length;
    header[2] = 2; // DIO
    header[3] = 0x2f; // 4 MB, 80 MHz
    headerView.setUint32(4, entry, true);
    header[8] = 0xee; // wp_pin disabled
    headerView.setUint16(12, 5, true); // ESP32-C3 chip_id
    header[17] = 0xff; // max_chip_rev_full low byte (no upper limit)
    header[18] = 0xff; // max_chip_rev_full high byte
    header[23] = 1; // SHA-256 appended

    /** @type {Uint8Array[]} */
    const chunks = [header];
    let checksum = 0xef;
    for (const segment of outputSegments) {
      const segmentHeader = new Uint8Array(8);
      const segmentView = new DataView(segmentHeader.buffer);
      segmentView.setUint32(0, segment.addr, true);
      segmentView.setUint32(4, segment.data.length, true);
      chunks.push(segmentHeader, segment.data);
      for (const byte of segment.data) checksum = (checksum ^ byte) & 0xff;
    }

    const unalignedLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const checksumOffset = unalignedLength + (15 - (unalignedLength % 16));
    const digestOffset = checksumOffset + 1;

    const output = new Uint8Array(digestOffset + 32);
    let writeOffset = 0;
    for (const chunk of chunks) {
      output.set(chunk, writeOffset);
      writeOffset += chunk.length;
    }
    output[checksumOffset] = checksum;

    const digest = createHash('sha256').update(output.subarray(0, digestOffset)).digest();
    output.set(digest, digestOffset);

    return output;
  }

  /** @param {Uint8Array} elf @returns {Uint8Array} */
  elfToBin(elf) {
    const view = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
    if (elf.length < 52 || view.getUint32(0, true) !== 0x464c457f) throw new Error('Invalid ELF image');
    const machine = view.getUint16(18, true);
    if (machine === 243) return this.elfToEsp32Bin(elf);

    const sectionOffset = view.getUint32(32, true);
    const sectionEntrySize = view.getUint16(46, true);
    const sectionCount = view.getUint16(48, true);
    if (sectionOffset === 0 || sectionEntrySize < 40 || sectionCount === 0) throw new Error('ELF image has no section table');

    let start = Number.MAX_SAFE_INTEGER;
    let end = 0;
    for (let index = 0; index < sectionCount; index++) {
      const offset = sectionOffset + index * sectionEntrySize;
      if (offset + 40 > elf.length) break;
      const address = view.getUint32(offset + 12, true);
      const fileOffset = view.getUint32(offset + 16, true);
      const size = view.getUint32(offset + 20, true);
      const type = view.getUint32(offset + 4, true);
      const flags = view.getUint32(offset + 8, true);
      if (type === 8 || (flags & 2) === 0 || address < 0x08000000) continue;
      if (fileOffset + size > elf.length) continue;
      start = Math.min(start, address);
      end = Math.max(end, address + size);
    }
    if (start === Number.MAX_SAFE_INTEGER || end <= start) throw new Error('ELF image has no flash sections');
    const bin = new Uint8Array(end - start);
    for (let index = 0; index < sectionCount; index++) {
      const offset = sectionOffset + index * sectionEntrySize;
      if (offset + 40 > elf.length) break;
      const address = view.getUint32(offset + 12, true);
      const fileOffset = view.getUint32(offset + 16, true);
      const size = view.getUint32(offset + 20, true);
      const type = view.getUint32(offset + 4, true);
      const flags = view.getUint32(offset + 8, true);
      if (type === 8 || (flags & 2) === 0 || address < 0x08000000) continue;
      if (fileOffset + size > elf.length) continue;
      bin.set(elf.subarray(fileOffset, fileOffset + size), address - start);
    }
    return bin;
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

/** @param {string} text */
const parseClangDiagnostics = (text) => {
  const diagnostics = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(.*?):(\d+):(\d+):\s+(fatal error|error|warning|note):\s*(.*)$/);
    if (!match) continue;
    const severity = match[4] === 'warning' ? 'warning' : match[4] === 'note' ? 'info' : 'error';
    diagnostics.push({
      severity,
      file: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
      message: match[5]
    });
  }
  return diagnostics;
};

/** @param {string} text */
const parseCodeCompletion = (text) => {
  const candidates = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^COMPLETION:\s*([^\s]+)(?:\s+:\s*(.*))?$/);
    if (match) candidates.push({ label: match[1], detail: match[2] ?? '' });
  }
  return candidates;
};

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

/**
 * Extract a member object from a Unix `ar` archive purely in JavaScript.
 * @param {Uint8Array} archive
 * @param {string} memberPrefix
 * @returns {Uint8Array}
 */
export const extractArchiveMember = (archive, memberPrefix) => {
  if (archive.length < 8 || Buffer.from(archive.subarray(0, 8)).toString('ascii') !== '!<arch>\n') {
    throw new Error('Invalid ar archive header');
  }
  let offset = 8;
  while (offset + 60 <= archive.length) {
    const rawName = Buffer.from(archive.subarray(offset, offset + 16)).toString('ascii').trim();
    const size = Number.parseInt(Buffer.from(archive.subarray(offset + 48, offset + 58)).toString('ascii').trim(), 10);
    const dataOffset = offset + 60;
    if (!Number.isFinite(size) || size < 0 || dataOffset + size > archive.length) {
      throw new Error(`Corrupt ar member header at offset ${offset}`);
    }
    if (rawName.startsWith(memberPrefix)) {
      const copy = new Uint8Array(size);
      copy.set(archive.subarray(dataOffset, dataOffset + size));
      return copy;
    }
    offset = dataOffset + size + (size & 1);
  }
  throw new Error(`Archive member '${memberPrefix}' not found`);
};

/**
 * Set ELF32 section header flags (e.g. SHF_ALLOC | SHF_EXECINSTR = 0x6) on a named section.
 * @param {Uint8Array} objectBytes
 * @param {string} sectionName
 * @param {number} flagsToSet
 * @returns {Uint8Array}
 */
export const patchElfSectionFlags = (objectBytes, sectionName, flagsToSet) => {
  const output = new Uint8Array(objectBytes.length);
  output.set(objectBytes);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  if (output.length < 52 || view.getUint32(0, true) !== 0x464c457f) {
    throw new Error('Invalid ELF32 object');
  }
  const shoff = view.getUint32(32, true);
  const shent = view.getUint16(46, true);
  const shnum = view.getUint16(48, true);
  const shstrndx = view.getUint16(50, true);
  const strOff = view.getUint32(shoff + shstrndx * shent + 16, true);

  for (let index = 0; index < shnum; index++) {
    const offset = shoff + index * shent;
    const nameIndex = view.getUint32(offset, true);
    let end = strOff + nameIndex;
    while (end < output.length && output[end] !== 0) end++;
    const name = Buffer.from(output.subarray(strOff + nameIndex, end)).toString('utf8');
    if (name === sectionName) {
      const currentFlags = view.getUint32(offset + 8, true);
      view.setUint32(offset + 8, currentFlags | flagsToSet, true);
    }
  }
  return output;
};

/**
 * Independent parser and validator for Espressif ESP32-C3 application images.
 * Checks magic, chip ID, entry point, segment table, 64 KB MMU alignment of
 * DROM/IROM segments, esp_app_desc_t magic, XOR checksum, and SHA-256 digest.
 * @param {Uint8Array} image
 * @returns {{valid:boolean,errors:string[],entry:number,chipId:number,segmentCount:number,hasAppDesc:boolean,checksum:number,expectedChecksum:number,sha256Valid:boolean,segments:Array<{index:number,loadAddr:number,length:number,fileOffset:number,mapped:boolean}>}}
 */
export const validateEsp32Image = (image) => {
  /** @type {string[]} */
  const errors = [];
  if (image.length < 24 + 1 + 32) {
    return { valid: false, errors: ['Image too small for ESP32 header, checksum, and SHA-256'], entry: 0, chipId: 0, segmentCount: 0, hasAppDesc: false, checksum: 0, expectedChecksum: 0, sha256Valid: false, segments: [] };
  }

  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const magic = image[0];
  const segmentCount = image[1];
  const entry = view.getUint32(4, true);
  const chipId = view.getUint16(12, true);
  const hashAppended = image[23];

  if (magic !== 0xe9) errors.push(`Invalid ESP32 image magic: 0x${magic.toString(16)} (expected 0xe9)`);
  if (segmentCount === 0 || segmentCount > 16) errors.push(`Invalid segment count: ${segmentCount}`);
  if (chipId !== 5) errors.push(`Unexpected chip_id: ${chipId} (expected 5 for ESP32-C3)`);
  if (entry < 0x4037c000 || entry >= 0x403e0000) errors.push(`Entry point 0x${entry.toString(16)} is outside ESP32-C3 IRAM`);

  let offset = 24;
  let computedChecksum = 0xef;
  let hasAppDesc = false;
  /** @type {Array<{index:number,loadAddr:number,length:number,fileOffset:number,mapped:boolean}>} */
  const segments = [];

  for (let index = 0; index < segmentCount; index++) {
    if (offset + 8 > image.length) {
      errors.push(`Truncated segment header at index ${index}`);
      break;
    }
    const loadAddr = view.getUint32(offset, true);
    const length = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    if (dataOffset + length > image.length) {
      errors.push(`Segment ${index} payload (0x${length.toString(16)} bytes) extends past EOF`);
      break;
    }
    if ((length & 3) !== 0) {
      errors.push(`Segment ${index} length ${length} is not 4-byte aligned`);
    }
    const isDrom = loadAddr >= 0x3c000000 && loadAddr < 0x3c800000;
    const isIrom = loadAddr >= 0x42000000 && loadAddr < 0x42800000;
    const mapped = isDrom || isIrom;
    if (mapped && ((dataOffset & 0xffff) !== (loadAddr & 0xffff))) {
      errors.push(
        `Flash-mapped segment ${index} at 0x${loadAddr.toString(16)} has misaligned file offset 0x${dataOffset.toString(16)} ` +
        `((fileOff & 0xffff)=0x${(dataOffset & 0xffff).toString(16)} != (loadAddr & 0xffff)=0x${(loadAddr & 0xffff).toString(16)})`
      );
    }
    if (isDrom && length >= 4 && view.getUint32(dataOffset, true) === 0xabcd5432) {
      hasAppDesc = true;
    }
    for (let byteIndex = 0; byteIndex < length; byteIndex++) {
      computedChecksum = (computedChecksum ^ image[dataOffset + byteIndex]) & 0xff;
    }
    segments.push({ index, loadAddr, length, fileOffset: dataOffset, mapped });
    offset = dataOffset + length;
  }

  const checksumOffset = offset + (15 - (offset % 16));
  const expectedChecksum = checksumOffset < image.length ? image[checksumOffset] : -1;
  if (checksumOffset >= image.length) {
    errors.push('Image truncated before checksum byte');
  } else if (computedChecksum !== expectedChecksum) {
    errors.push(`Checksum mismatch: computed 0x${computedChecksum.toString(16)}, stored 0x${expectedChecksum.toString(16)}`);
  }

  let sha256Valid = false;
  if (hashAppended === 1) {
    const digestOffset = checksumOffset + 1;
    if (digestOffset + 32 !== image.length) {
      errors.push(`Expected 32-byte SHA-256 at 0x${digestOffset.toString(16)}, image size is 0x${image.length.toString(16)}`);
    } else {
      const actualDigest = createHash('sha256').update(image.subarray(0, digestOffset)).digest();
      sha256Valid = Buffer.compare(actualDigest, image.subarray(digestOffset, digestOffset + 32)) === 0;
      if (!sha256Valid) errors.push('SHA-256 digest mismatch');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    entry,
    chipId,
    segmentCount,
    hasAppDesc,
    checksum: computedChecksum,
    expectedChecksum,
    sha256Valid,
    segments
  };
};
