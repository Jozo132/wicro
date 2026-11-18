import { WASI } from 'node:wasi';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
