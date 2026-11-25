import { Stk500Programmer, validateNanoFirmware } from './stk500.js';

export class NanoBrowserProgrammer {
  /** @param {{baudRate?:number,onProgress?:(event:{stage:string,message:string,percent:number})=>void}} [options] */
  constructor(options = {}) { this.options = options; }
  /** @param {any} port @param {Uint8Array} image */
  async writeFlash(port, image) {
    validateNanoFirmware(image);
    await port.open({ baudRate: this.options.baudRate ?? 115200 });
    const reader = port.readable.getReader(), writer = port.writable.getWriter();
    /** @type {number[]} */
    let queue = [];
    let running = true;
    /** @type {unknown} */
    let readError;
    const reading = (async () => {
      try { while (running) { const result = await reader.read(); if (result.done) break; queue.push(...result.value); if (queue.length > 4096) throw new Error('Nano serial receive overflow'); } }
      catch (error) { if (running) readError = error; }
    })();
    const programmer = new Stk500Programmer({ onProgress: this.options.onProgress, transport: {
      flush: () => { queue = []; }, write: (bytes) => writer.write(bytes), setSignals: (dtr, rts) => port.setSignals({ dataTerminalReady: dtr, requestToSend: rts }),
      read: async (length, timeout) => {
        const deadline = Date.now() + timeout;
        while (queue.length < length && Date.now() < deadline && !readError) await new Promise((resolve) => setTimeout(resolve, 1));
        if (readError) throw readError;
        if (queue.length < length) throw new Error('STK500 browser serial response timeout');
        return Uint8Array.from(queue.splice(0, length));
      }
    } });
    try { const identity = await programmer.connect(); return { ...await programmer.writeFlash(image), identity }; }
    finally { running = false; await reader.cancel(); await reading; reader.releaseLock(); writer.releaseLock(); await port.close(); }
  }
}
