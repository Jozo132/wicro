import { PicoBootProgrammer } from './picoboot.js';
import { validateRp2040Image } from '../../runtime/src/rp2040-image.js';

export class Rp2040BrowserProgrammer {
  /** @param {{onProgress?:(event:{stage:string,message:string,percent:number})=>void}} [options] */
  constructor(options = {}) { this.options = options; }
  requestRomDevice() {
    const usb = /** @type {any} */ (globalThis.navigator)?.usb;
    if (!usb) throw new Error('WebUSB is required for RP2040 PICOBOOT');
    return usb.requestDevice({ filters: [{ vendorId: 0x2e8a, productId: 3 }] });
  }
  requestRuntimeDevice() {
    const usb = /** @type {any} */ (globalThis.navigator)?.usb;
    if (!usb) throw new Error('WebUSB is required for RP2040 diagnostics');
    return usb.requestDevice({ filters: [{ vendorId: 0, productId: 1, serialNumber: 'WICRO-RP2040-ZERO' }] });
  }
  /** @param {any} device */
  async enterRom(device) {
    if (device.vendorId !== 0 || device.productId !== 1 || device.serialNumber !== 'WICRO-RP2040-ZERO') throw new Error('Select Wicro RP2040-Zero diagnostic firmware');
    await device.open();
    try {
      if (!device.configuration) await device.selectConfiguration(1);
      await device.claimInterface(0);
      const result = await device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0x5b, value: 0, index: 0 }, new Uint8Array());
      if (result.status !== 'ok') throw new Error('RP2040 ROM entry request failed');
      return { requested: true, confirmed: false };
    } finally { await device.close(); }
  }
  /** @param {any} device @param {Uint8Array} image */
  async writeFlash(device, image) {
    validateRp2040Image(image);
    const programmer = new PicoBootProgrammer({ device, onProgress: this.options.onProgress });
    await programmer.open();
    try { return await programmer.writeFlash(image); }
    finally { await programmer.close(); }
  }
}
