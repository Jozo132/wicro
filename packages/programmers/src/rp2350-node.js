import { usb } from 'usb';
import { PicoBootProgrammer } from './picoboot.js';
import { Rp2040NodeProgrammer } from './rp2040-node.js';
import { validateRp2350Image } from '../../runtime/src/rp2350-image.js';

/** RP2350 discovery is separate so RP2040 uploads cannot select this device. */
export class Rp2350NodeProgrammer extends Rp2040NodeProgrammer {
  async findRom() {
    const devices = (await usb.getDevices()).filter((device) => device.vendorId === 0x2e8a && device.productId === 15 && (!this.options.serialNumber || device.serialNumber === this.options.serialNumber));
    if (devices.length > 1) throw new Error('Multiple RP2350 ROM devices match; select a serial number');
    return devices[0] ?? null;
  }
  async findRuntime() {
    const devices = (await usb.getDevices()).filter((device) => device.vendorId === 0 && device.productId === 1 && device.serialNumber === 'WICRO-RP2350');
    if (devices.length > 1) throw new Error('Multiple RP2350 diagnostic runtimes match; use hardware BOOTSEL');
    return devices[0] ?? null;
  }
  /** @param {Uint8Array} image @param {{onBackup?:(bytes:Uint8Array)=>Promise<void>,reboot?:boolean}} [options] */
  async writeFlash(image, options = {}) {
    validateRp2350Image(image);
    const device = await this.enterRom(), programmer = new PicoBootProgrammer({ device, chip: 'RP2350', onProgress: this.options.onProgress });
    await programmer.open();
    try { return await programmer.writeFlash(image, options); }
    finally { await programmer.close(); }
  }
}
