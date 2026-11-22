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
  }

  /**
   * @param {Uint8Array|string} wasm
   * @param {WasiRunOptions} [options]
   * @returns {Promise<WasiRunResult>}
   */
  async run(wasm, options = {}) {
    const bytes = typeof wasm === 'string' ? await readFile(wasm) : wasm;
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

    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const module = await WebAssembly.compile(copy);
    const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
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
   * Link explicit object/archive inputs with LLD entirely through the WASM toolchain.
   * @param {{objects:Record<string,Uint8Array>|Uint8Array[],archives?:Record<string,Uint8Array>,linkerScripts?:Record<string,string|string|Uint8Array>,libraryPaths?:string[],libraries?:string[],undefinedSymbols?:string[],target:string,targetOptions?:{march?:string,mabi?:string,mcpu?:string,mcu?:string},entry?:string,preopens?:Record<string,string>}} options
   */
  async linkEsp32Elf(options) {
    const directory = await mkdtemp(join(tmpdir(), 'wicro-esp32-link-'));
    try {
      /** @type {[string,Uint8Array][]} */
      const objectEntries = Array.isArray(options.objects)
        ? options.objects.map((data, index) => [`object-${index}.o`, data])
        : Object.entries(options.objects).map(([name, data]) => [name, /** @type {Uint8Array} */ (data)]);
      for (const [name, data] of objectEntries) {
        if (name.includes('..') || name.startsWith('/')) throw new Error(`Unsafe object path: ${name}`);
        await mkdir(join(directory, name).slice(0, join(directory, name).lastIndexOf('/')), { recursive: true });
        await writeFile(join(directory, name), data);
      }

      for (const [name, data] of Object.entries(options.archives ?? {})) {
        if (name.includes('..') || name.startsWith('/')) throw new Error(`Unsafe archive path: ${name}`);
        await mkdir(join(directory, name).slice(0, join(directory, name).lastIndexOf('/')), { recursive: true });
        await writeFile(join(directory, name), data);
      }

      /** @type {string[]} */
      const linkerArgs = [];
      for (const [name, script] of Object.entries(options.linkerScripts ?? {})) {
        if (name.includes('..') || name.startsWith('/')) throw new Error(`Unsafe linker script path: ${name}`);
        await mkdir(join(directory, name).slice(0, join(directory, name).lastIndexOf('/')), { recursive: true });
        await writeFile(join(directory, name), script);
        linkerArgs.push('-T', `/tmp/${name}`);
      }

      const args = [
        'ld.lld',
        '--gc-sections',
        '-EL',
        ...(options.entry ? ['-e', options.entry] : []),
        ...linkerArgs,
        '--start-group',
        ...objectEntries.map(([name]) => `/tmp/${name}`),
        ...Object.keys(options.archives ?? {}).map((name) => `/tmp/${name}`),
        '--end-group',
        ...options.undefinedSymbols?.flatMap((symbol) => ['-u', symbol]) ?? [],
        ...options.libraryPaths?.flatMap((libraryPath) => ['-L', `/tmp/${libraryPath}`]) ?? [],
        ...options.libraries?.flatMap((library) => ['-l', library]) ?? [],
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

  /** @param {Uint8Array} elf @returns {Uint8Array} */
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

    const programOffset = view.getUint32(28, true);
    const programEntrySize = view.getUint16(42, true);
    const programCount = view.getUint16(44, true);
    if (programOffset === 0 || programEntrySize < 32 || programCount === 0) {
      throw new Error('ELF image has no loadable program headers');
    }

    /** @type {Array<{address:number,offset:number,size:number,flags:number}>} */
    const segments = [];
    for (let index = 0; index < programCount; index++) {
      const offset = programOffset + index * programEntrySize;
      if (offset + 32 > elf.length) break;
      const type = view.getUint32(offset, true);
      const fileOffset = view.getUint32(offset + 4, true);
      const address = view.getUint32(offset + 12, true);
      const fileSize = view.getUint32(offset + 16, true);
      const flags = view.getUint32(offset + 24, true);
      if (type !== 1 || fileSize === 0) continue;
      if (fileOffset + fileSize > elf.length) throw new Error(`ELF segment ${index} extends beyond the file`);
      if (address === 0) continue;
      segments.push({ address, offset: fileOffset, size: fileSize, flags });
    }

    if (segments.length === 0) throw new Error('ELF image has no loadable ESP32 segments');

    const entry = view.getUint32(24, true);
    const ramSegments = segments.filter((segment) =>
      (segment.address >= 0x3fc00000 && segment.address < 0x40000000) ||
      (segment.address >= 0x40300000 && segment.address < 0x42000000));
    const flashSegments = segments.filter((segment) => segment.address >= 0x42000000 && segment.address < 0x44000000);
    const dromSegments = segments.filter((segment) => segment.address >= 0x3c000000 && segment.address < 0x40000000);
    const iromSegments = flashSegments.filter((segment) => segment.address >= 0x42000000 && segment.address < 0x44000000);
    const outputSegments = [...dromSegments.sort((left, right) => left.address - right.address), ...ramSegments.sort((left, right) => left.address - right.address), ...iromSegments.sort((left, right) => left.address - right.address)]
      .filter((segment, index, all) => all.findIndex((candidate) => candidate.address === segment.address) === index);

    if (outputSegments.length > 16) throw new Error(`ELF image has too many segments (${outputSegments.length})`);

    const header = new Uint8Array(24);
    const headerView = new DataView(header.buffer);
    header[0] = 0xe9;
    header[1] = outputSegments.length;
    header[2] = 2;
    header[3] = 0x2f;
    headerView.setUint32(4, entry, true);

    headerView.setUint8(8, 0xee);
    headerView.setUint8(9, 0x00);
    headerView.setUint8(10, 0x00);
    headerView.setUint8(11, 0x00);
    headerView.setUint16(12, 5, true);
    headerView.setUint16(14, 0, true);
    headerView.setUint16(16, 0, true);
    headerView.setUint16(18, 0, true);
    headerView.setUint8(20, 0);
    headerView.setUint8(21, 0);
    headerView.setUint8(22, 0);
    headerView.setUint8(23, 1);

    const chunks = [header];
    let checksum = 0xef;
    for (const segment of outputSegments) {
      const data = elf.subarray(segment.offset, segment.offset + segment.size);
      const paddedSize = (data.length + 3) & ~3;
      const padded = new Uint8Array(paddedSize);
      padded.set(data);

      const segmentHeader = new Uint8Array(8);
      const segmentView = new DataView(segmentHeader.buffer);
      segmentView.setUint32(0, segment.address, true);
      segmentView.setUint32(4, paddedSize, true);
      chunks.push(segmentHeader, padded);
      for (const byte of data) checksum = (checksum ^ byte) & 0xff;
    }

    const unalignedLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const checksumOffset = unalignedLength + (15 - (unalignedLength % 16));
    const digestOffset = checksumOffset + 1;

    const combinedLength = digestOffset + 32;
    const output = new Uint8Array(combinedLength);
    let writeOffset = 0;
    for (const chunk of chunks) {
      output.set(chunk, writeOffset);
      writeOffset += chunk.length;
    }
    output[checksumOffset] = checksum;

    const digest = createHash('sha256').update(output.subarray(0, digestOffset)).digest('hex');
    for (let index = 0; index < 32; index++) {
      output[digestOffset + index] = Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16);
    }

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
