import { SerialPort } from 'serialport';
import { Stk500Programmer, validateNanoFirmware } from './stk500.js';

export class NanoNodeProgrammer {
  /** @param {{path:string,baudRate?:number,onProgress?:(event:{stage:string,message:string,percent:number})=>void}} options */
  constructor(options) { this.options = options; }
  /** @param {(programmer:Stk500Programmer,identity:{signature:string,major:number,minor:number})=>Promise<any>} action */
  async session(action) {
    const port = new SerialPort({ path: this.options.path, baudRate: this.options.baudRate ?? 115200, autoOpen: false });
    /** @type {number[]} */
    let queue = [];
    port.on('data', (bytes) => queue.push(...bytes));
    await new Promise((resolve, reject) => port.open((error) => error ? reject(error) : resolve(undefined)));
    const programmer = new Stk500Programmer({ onProgress: this.options.onProgress, transport: {
      flush: () => { queue = []; },
      setSignals: (dtr, rts) => new Promise((resolve, reject) => port.set({ dtr, rts }, (error) => error ? reject(error) : resolve())),
      write: (bytes) => new Promise((resolve, reject) => port.write(bytes, (error) => error ? reject(error) : resolve())),
      read: async (length, timeout) => {
        const deadline = Date.now() + timeout;
        while (queue.length < length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
        if (queue.length < length) throw new Error('STK500 serial response timeout');
        return Uint8Array.from(queue.splice(0, length));
      }
    } });
    try { return await action(programmer, await programmer.connect()); }
    finally { if (port.isOpen) await new Promise((resolve, reject) => port.close((error) => error ? reject(error) : resolve(undefined))); }
  }
  /** @param {Uint8Array} image */
  writeFlash(image) { validateNanoFirmware(image); return this.session(async (programmer, identity) => ({ ...await programmer.writeFlash(image), identity, path: this.options.path })); }
}
