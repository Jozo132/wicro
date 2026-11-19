import { WASI } from 'node:wasi';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  /** @param {string} source @param {string} target @param {{march?:string,mabi?:string,mcpu?:string,mcu?:string}} [targetOptions] */
  async compileC(source, target = 'riscv32', targetOptions = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'wicro-llvm-'));

    try {
      await writeFile(join(directory, 'main.c'), source);
      const result = await this.runner.run(this.llvmPath, {
        args: [
          'clang',
          ...this.targetArgs(target, targetOptions),
          '-nostdlib',
          '-c',
          '/tmp/main.c',
          '-o',
          '/tmp/main.o'
        ],
        preopens: { '/tmp': directory }
      });

      if (result.exitCode !== 0) {
        throw new Error(result.stderr || result.stdout || `Compiler exited with status ${result.exitCode}`);
      }

      const object = await readFile(join(directory, 'main.o'));
      return { object, target, diagnostics: result.stderr ? [result.stderr] : [] };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /**
   * Compile a bare-metal main and C startup source, then link a complete ELF.
   * @param {{source:string,startupSource:string,linkerScript:string,target:string,targetOptions?:{march?:string,mabi?:string,mcpu?:string,mcu?:string}}} options
   */
  async compileAndLinkBareMetal(options) {
    const directory = await mkdtemp(join(tmpdir(), 'wicro-bare-metal-'));

    try {
      await writeFile(join(directory, 'main.c'), options.source);
      await writeFile(join(directory, 'startup.c'), options.startupSource);
      await writeFile(join(directory, 'firmware.ld'), options.linkerScript);

      const files = [
        ['main.c', 'main.o'],
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

  /** @param {Uint8Array} elf @returns {Uint8Array} */
  elfToBin(elf) {
    const view = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
    if (elf.length < 52 || view.getUint32(0, true) !== 0x464c457f) {
      throw new Error('Invalid ELF32 image');
    }

    const sectionOffset = view.getUint32(32, true);
    const sectionEntrySize = view.getUint16(46, true);
    const sectionCount = view.getUint16(48, true);

    if (sectionOffset === 0 || sectionEntrySize < 40 || sectionCount === 0) {
      throw new Error('ELF image has no section table');
    }

    let start = Number.MAX_SAFE_INTEGER;
    let end = 0;
    /** @type {Array<{address:number,offset:number,size:number}>} */
    const sections = [];

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
      sections.push({ address, offset: fileOffset, size });
    }

    if (!sections.length || start === Number.MAX_SAFE_INTEGER || end <= start) {
      throw new Error('ELF image has no flash sections');
    }

    const bin = new Uint8Array(end - start);
    for (const section of sections) {
      bin.set(elf.subarray(section.offset, section.offset + section.size), section.address - start);
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
