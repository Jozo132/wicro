import { StLinkProbe, STLINK_PRODUCT_IDS, validateStm32F103Image } from './stlink.js';

export class StLinkBrowserProgrammer {
  /** @param {{onProgress?:(event:{stage:string,message:string,percent:number})=>void}} [options] */
  constructor(options = {}) { this.options = options; }
  requestDevice() {
    const usb = /** @type {any} */ (globalThis.navigator)?.usb;
    if (!usb) throw new Error('WebUSB is required for ST-Link');
    return usb.requestDevice({ filters: STLINK_PRODUCT_IDS.map((productId) => ({ vendorId: 0x0483, productId })) });
  }
  /** @param {any} device @param {Uint8Array} image @param {number} [capacity] */
  async writeFlash(device, image, capacity = 65536) {
    validateStm32F103Image(image, capacity);
    const probe = new StLinkProbe({ device, onProgress: this.options.onProgress });
    await probe.open();
    try { return await probe.writeFlash(image, { capacity }); }
    finally { await probe.close(); }
  }
}
