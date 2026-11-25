import { triggerCdcDfu } from './cdc-dfu-trigger.js';
import { validateCortexMImage } from './cdc-dfu-profile.js';
import { openDfuDevice } from './dfu-usb.js';
import { UsbDfuProgrammer } from './dfu.js';

/** Keep permission prompts in separate user gestures: trigger CDC, then choose DFU. */
export class BrowserCdcDfuProgrammer {
  /** @param {{profile:import('./cdc-dfu-profile.js').CdcDfuProfile}} options */
  constructor(options) { this.profile = options.profile; }

  /** Call directly from a click; selecting the runtime port grants no DFU permission. */
  requestRuntimePort() {
    const serial = /** @type {any} */ (globalThis.navigator)?.serial;
    if (!serial) throw new Error('Web Serial is required for the CDC trigger');
    return serial.requestPort({ filters: [{ usbVendorId: this.profile.runtimeVendorId, usbProductId: this.profile.runtimeProductId }] });
  }

  /** Call directly from a second click after DFU enumeration (or hardware BOOT0/reset). */
  requestDfuDevice() {
    const usb = /** @type {any} */ (globalThis.navigator)?.usb;
    if (!usb) throw new Error('WebUSB is required for DFU flashing');
    const p = this.profile;
    return usb.requestDevice({ filters: [{ vendorId: p.dfuVendorId, productId: p.dfuProductId, ...(p.serialNumber ? { serialNumber: p.serialNumber } : {}) }] });
  }

  /** @param {any} port */
  async trigger(port) {
    const info = port.getInfo();
    if (info.usbVendorId !== this.profile.runtimeVendorId || info.usbProductId !== this.profile.runtimeProductId) throw new Error('Selected serial port does not match the configured CDC identity');
    await port.open({ baudRate: 115200 });
    const writer = port.writable.getWriter();
    try { await triggerCdcDfu({ setDtr: (value) => port.setSignals({ dataTerminalReady: value }), write: (bytes) => writer.write(bytes) }); }
    finally { writer.releaseLock(); await port.close(); }
    // The second click selects the actual DFU device; sending bytes alone is
    // deliberately not reported as a confirmed CDC-to-DFU transition.
    return { sent: true, transitionConfirmed: false };
  }

  /** @param {any} device @param {Uint8Array} data @param {{onProgress?:(event:{stage:string,message:string,percent:number})=>void}} [options] */
  async writeFlash(device, data, options = {}) {
    const p = this.profile;
    validateCortexMImage(data, p);
    if (device.vendorId !== p.dfuVendorId || device.productId !== p.dfuProductId || p.serialNumber && device.serialNumber !== p.serialNumber) throw new Error('Selected USB device does not match the DFU profile');
    const session = await openDfuDevice(device, p);
    try {
      const result = await new UsbDfuProgrammer({ transport: session.transport, ...session.descriptor, profile: p, sectors: session.sectors, onProgress: options.onProgress }).writeFlash([{ address: p.address, data }], { verifyReadback: true });
      return { ...result, chip: 'STM32F401RC USB DFU', mac: undefined, serialNumber: device.serialNumber, reboot: { confirmed: false } };
    } finally { if (device.opened) await session.close(); }
  }
}
