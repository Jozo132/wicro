import { usb } from 'usb';
import { StLinkProbe, STLINK_PRODUCT_IDS, readStLinkSerial, validateStm32F103Image } from './stlink.js';

export class StLinkNodeProgrammer {
  /** @param {{serialNumber?:string,expectedUid?:string,capacity?:number,onProgress?:(event:{stage:string,message:string,percent:number})=>void}} [options] */
  constructor(options = {}) { this.options = options; }
  async findDevice() {
    const devices = (await usb.getDevices()).filter((device) => device.vendorId === 0x0483 && STLINK_PRODUCT_IDS.includes(device.productId));
    if (!this.options.serialNumber) {
      if (devices.length !== 1) throw new Error('Select exactly one ST-Link or provide --serial');
      return devices[0];
    }
    const matches = [];
    for (const device of devices) {
      await device.open();
      try { if (await readStLinkSerial(device) === this.options.serialNumber.toLowerCase()) matches.push(device); }
      finally { await device.close(); }
    }
    if (matches.length !== 1) throw new Error('ST-Link serial did not select exactly one probe');
    return matches[0];
  }
  /** @template T @param {(probe:StLinkProbe)=>Promise<T>} operation */
  async session(operation) {
    const probe = new StLinkProbe({ device: await this.findDevice(), onProgress: this.options.onProgress });
    await probe.open();
    try { return await operation(probe); }
    finally { await probe.close(); }
  }
  inspect() { return this.session((probe) => probe.identify()); }
  /** @param {Uint8Array} image @param {{onBackup?:(bytes:Uint8Array)=>Promise<void>}} [options] */
  writeFlash(image, options = {}) {
    const capacity = this.options.capacity ?? 65536;
    validateStm32F103Image(image, capacity);
    return this.session((probe) => probe.writeFlash(image, { ...options, capacity, expectedUid: this.options.expectedUid }));
  }
}
