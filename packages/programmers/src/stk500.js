/** @param {Uint8Array} image */
export const validateNanoFirmware = (image) => {
  if (!(image instanceof Uint8Array) || image.length < 4 || image.length > 30720) throw new Error('Nano image must fit the 30720-byte application region; bootloader writes are forbidden');
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const opcode = view.getUint16(0, true);
  let entry;
  if ((opcode & 0xfe0e) === 0x940c) entry = (((opcode & 0x1f0) << 13) | ((opcode & 1) << 16) | view.getUint16(2, true)) * 2;
  else if ((opcode & 0xf000) === 0xc000) { const value = opcode & 0xfff; entry = (1 + (value & 0x800 ? value - 4096 : value)) * 2; }
  else throw new Error('Nano firmware needs an AVR reset JMP/RJMP vector');
  if (entry < 0 || entry >= image.length) throw new Error('AVR reset entry is outside the application image');
  return { entry };
};

/** STK500v1 UART bootloader protocol for the ATmega328P Nano. */
/** @typedef {{write:(bytes:Uint8Array)=>Promise<void>,read:(length:number,timeout:number)=>Promise<Uint8Array>,flush:()=>void,setSignals:(dtr:boolean,rts:boolean)=>Promise<void>}} Stk500Transport */
export class Stk500Programmer {
  /** @param {{transport:Stk500Transport,onProgress?:(event:{stage:string,message:string,percent:number})=>void}} options */
  constructor(options) { this.options = options; }
  /** @param {number[]} bytes @param {number} [length] */
  async command(bytes, length = 0) {
    const t = this.options.transport;
    t.flush();
    await t.write(Uint8Array.from([...bytes, 0x20]));
    const response = await t.read(length + 2, 1000);
    if (response[0] !== 0x14 || response[response.length - 1] !== 0x10) throw new Error('STK500 bootloader returned an invalid response');
    return response.subarray(1, response.length - 1);
  }
  async connect() {
    const t = this.options.transport;
    await t.setSignals(false, false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await t.setSignals(true, false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await t.setSignals(false, false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    let connected = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await this.command([0x30]); connected = true; break; } catch { /* Retry sync only, before any write. */ }
    }
    if (!connected) throw new Error('Nano STK500 sync failed; check port and 115200/57600 bootloader selection');
    await this.command([0x50]);
    const signature = await this.command([0x75], 3);
    if (signature.join(',') !== '30,149,15') throw new Error(`Expected ATmega328P signature 1e950f; got ${Array.from(signature).map((value) => value.toString(16)).join('')}`);
    return { signature: '1e950f', major: (await this.command([0x41, 0x81], 1))[0], minor: (await this.command([0x41, 0x82], 1))[0] };
  }
  /** @param {number} address */
  async address(address) {
    if (!Number.isInteger(address) || address < 0 || address % 2 || address >= 32768) throw new Error('Invalid AVR flash word address');
    const word = address / 2; await this.command([0x55, word & 255, word >> 8]);
  }
  /** @param {number} address @param {number} length */
  async readFlash(address, length) {
    if (!Number.isInteger(length) || length < 1 || address + length > 32768) throw new Error('Invalid AVR read range');
    const output = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += 128) {
      await this.address(address + offset);
      const size = Math.min(128, length - offset);
      output.set(await this.command([0x74, size >> 8, size & 255, 0x46], size), offset);
    }
    return output;
  }
  /** @param {Uint8Array} image */
  async writeFlash(image) {
    validateNanoFirmware(image);
    for (let offset = 0; offset < image.length; offset += 128) {
      const page = new Uint8Array(128).fill(255); page.set(image.subarray(offset, offset + 128));
      await this.address(offset);
      await this.command([0x64, 0, 128, 0x46, ...page]);
      const read = await this.readFlash(offset, 128);
      if (!read.every((value, index) => value === page[index])) throw new Error(`Nano readback mismatch at byte ${offset}`);
      this.options.onProgress?.({ stage: 'write', message: `Programmed and verified page ${offset / 128 + 1}`, percent: Math.min(95, Math.round((offset + 128) / image.length * 95)) });
    }
    await this.command([0x51]);
    return { ok: true, chip: 'ATmega328P', mac: undefined, readback: { verified: true, bytes: image.length }, reboot: { requested: true, confirmed: false } };
  }
}
