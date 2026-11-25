import { usb } from 'usb';
import { PicoBootProgrammer } from './picoboot.js';
import { validateRp2040Image } from '../../runtime/src/rp2040-image.js';

export class Rp2040NodeProgrammer {
  /** @param {{serialNumber?:string,onProgress?:(event:{stage:string,message:string,percent:number})=>void}} [options] */
  constructor(options = {}) { this.options = options; }
  async findRom() {
    const devices = (await usb.getDevices()).filter((device) => device.vendorId === 0x2e8a && device.productId === 3 && (!this.options.serialNumber || device.serialNumber === this.options.serialNumber));
    if (devices.length > 1) throw new Error('Multiple RP2040 ROM devices match; select a serial number');
    return devices[0] ?? null;
  }
  async findRuntime() {
    const devices = (await usb.getDevices()).filter((device) => device.vendorId === 0 && device.productId === 1 && device.serialNumber === 'WICRO-RP2040-ZERO');
    if (devices.length > 1) throw new Error('Multiple diagnostic runtimes match; use hardware BOOTSEL on the selected target');
    return devices[0] ?? null;
  }
  async enterRom() {
    const existing = await this.findRom(); if (existing) return existing;
    const runtime = await this.findRuntime();
    if (!runtime) throw new Error('Put the selected RP2 board in ROM mode using BOOT + reset');
    await runtime.open();
    try {
      if (!runtime.configuration) await runtime.selectConfiguration(1);
      await runtime.claimInterface(0);
      const result = await runtime.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0x5b, value: 0, index: 0 }, new Uint8Array());
      if (result.status !== 'ok') throw new Error('RP2 runtime rejected ROM boot request');
    } finally { await runtime.close(); }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { const device = await this.findRom(); if (device) return device; await new Promise((resolve) => setTimeout(resolve, 100)); }
    throw new Error('RP2 ROM re-enumeration was not confirmed');
  }
  /** @param {Uint8Array} image @param {{onBackup?:(bytes:Uint8Array)=>Promise<void>,reboot?:boolean}} [options] */
  async writeFlash(image, options = {}) {
    validateRp2040Image(image);
    const device = await this.enterRom(), programmer = new PicoBootProgrammer({ device, onProgress: this.options.onProgress });
    await programmer.open();
    try { return await programmer.writeFlash(image, options); }
    finally { await programmer.close(); }
  }
}
