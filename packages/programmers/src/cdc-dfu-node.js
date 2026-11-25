import { SerialPort } from 'serialport';
import { usb } from 'usb';
import { triggerCdcDfu } from './cdc-dfu-trigger.js';
import { openDfuDevice } from './dfu-usb.js';
import { UsbDfuProgrammer } from './dfu.js';

import { validateCortexMImage } from './cdc-dfu-profile.js';
/** @typedef {import('./cdc-dfu-profile.js').CdcDfuProfile} CdcDfuProfile */

/** Direct USB CDC control is useful when tty modem-control ioctls are unsupported. @param {any} device @param {(message:string)=>void} [log] */
export const triggerNodeUsbCdcDfu = async (device, log) => {
  await device.open();
  const detached = [];
  try {
    if (!device.configuration) await device.selectConfiguration(device.configurations[0].configurationValue);
    const control = device.configuration.interfaces.find((/** @type {any} */ iface) => iface.alternates.some((/** @type {any} */ alt) => alt.interfaceClass === 2 && alt.interfaceSubclass === 2));
    const data = device.configuration.interfaces.find((/** @type {any} */ iface) => iface.alternates.some((/** @type {any} */ alt) => alt.interfaceClass === 10 && alt.endpoints.some((/** @type {any} */ ep) => ep.direction === 'out' && ep.type === 'bulk')));
    if (!control || !data) throw new Error('CDC ACM control/data interfaces were not found');
    for (const iface of [control, data]) {
      if (device.detachKernelDriver) {
        try { await device.detachKernelDriver(iface.interfaceNumber); detached.push(iface.interfaceNumber); }
        catch (error) { if (!/not found|not supported|no (?:kernel )?driver/i.test(String(error))) throw error; }
      }
      await device.claimInterface(iface.interfaceNumber);
    }
    /** @param {number} request @param {number} value @param {Uint8Array} bytes */
    const out = async (request, value, bytes) => {
      const result = await device.controlTransferOut({ requestType: 'class', recipient: 'interface', request, value, index: control.interfaceNumber }, bytes);
      if (result.status !== 'ok' || result.bytesWritten !== bytes.length) throw new Error('USB CDC control transfer failed');
    };
    await out(0x20, 0, Uint8Array.of(0x00, 0xc2, 0x01, 0, 0, 0, 8));
    const endpoint = data.alternate.endpoints.find((/** @type {any} */ ep) => ep.direction === 'out' && ep.type === 'bulk');
    await triggerCdcDfu({
      setDtr: (value) => out(0x22, value ? 1 : 0, new Uint8Array()),
      write: async (bytes) => {
        const result = await device.transferOut(endpoint.endpointNumber, bytes);
        if (result.status !== 'ok' || result.bytesWritten !== bytes.length) throw new Error('USB CDC magic bytes were not fully written');
      }
    });
  } finally {
    for (const iface of detached) { try { await device.releaseInterface(iface); await device.attachKernelDriver(iface); } catch (error) { log?.(`CDC interface released after USB transition: ${String(error)}`); } }
    try { await device.close(); } catch (error) { log?.(`CDC device closed after USB transition: ${String(error)}`); }
  }
};

export class NodeCdcDfuProgrammer {
  /** @param {{profile:CdcDfuProfile,onLog?:(message:string)=>void,onProgress?:(event:{stage:string,message:string,percent:number})=>void}} options */
  constructor(options) { this.options = options; }

  /** @param {string} [serialNumber] */
  async findDfu(serialNumber) {
    const p = this.options.profile;
    const devices = (await usb.getDevices()).filter((device) => device.vendorId === p.dfuVendorId && device.productId === p.dfuProductId && (!(serialNumber ?? p.serialNumber) || device.serialNumber === (serialNumber ?? p.serialNumber)));
    if (devices.length > 1) throw new Error('Multiple DFU devices match; configure a serial number');
    return devices[0] ?? null;
  }

  /** @param {string} [path] */
  async findCdc(path) {
    const p = this.options.profile;
    const ports = (await SerialPort.list()).filter((port) => (!path || port.path === path) && Number.parseInt(port.vendorId ?? '', 16) === p.runtimeVendorId && Number.parseInt(port.productId ?? '', 16) === p.runtimeProductId && (!p.serialNumber || port.serialNumber === p.serialNumber));
    if (ports.length > 1) throw new Error('Multiple CDC devices match; configure a serial number or port');
    return ports[0] ?? null;
  }

  /** @param {{path?:string,trigger?:boolean,triggerTransport?:'serial'|'usb',timeoutMs?:number}} [options] */
  async enterDfu(options = {}) {
    const present = await this.findDfu();
    if (present) return { device: present, triggered: false };
    if (options.trigger === false) throw new Error('Target is not in DFU mode; use BOOT0/reset or enable the matching CDC trigger');
    const cdc = await this.findCdc(options.path);
    if (!cdc) throw new Error('Matching CDC firmware is not enumerated; first flash requires hardware DFU entry');
    const devices = (await usb.getDevices()).filter((device) => device.vendorId === this.options.profile.runtimeVendorId && device.productId === this.options.profile.runtimeProductId && (!cdc.serialNumber || device.serialNumber === cdc.serialNumber));
    if (devices.length !== 1) throw new Error('Select one matching CDC USB identity');
    if (options.triggerTransport !== 'serial') {
      let triggerError;
      try { await triggerNodeUsbCdcDfu(devices[0], this.options.onLog); } catch (error) { triggerError = String(error); }
      const deadline = Date.now() + (options.timeoutMs ?? 5000);
      while (Date.now() < deadline) {
        const device = await this.findDfu(cdc.serialNumber);
        if (device) return { device, triggered: true, triggerError };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`USB CDC trigger did not produce the selected DFU device${triggerError ? `: ${triggerError}` : ''}`);
    }
    const port = new SerialPort({ path: cdc.path, baudRate: 115200, autoOpen: false });
    /** @type {string|undefined} */
    let triggerError;
    try {
      await new Promise((resolve, reject) => port.open((error) => error ? reject(error) : resolve(undefined)));
      await triggerCdcDfu({
        setDtr: (value) => new Promise((resolve, reject) => port.set({ dtr: value }, (error) => error ? reject(error) : resolve())),
        write: (bytes) => new Promise((resolve, reject) => port.write(bytes, (error) => error ? reject(error) : port.drain((error) => error ? reject(error) : resolve())))
      });
    } catch (error) { triggerError = error instanceof Error ? error.message : String(error); }
    finally { if (port.isOpen) await new Promise((resolve) => port.close((error) => { if (error) this.options.onLog?.(`CDC close: ${error.message}`); resolve(undefined); })); }
    const deadline = Date.now() + (options.timeoutMs ?? 5000);
    while (Date.now() < deadline) {
      const device = await this.findDfu(cdc.serialNumber);
      if (device) {
        this.options.onLog?.(`CDC to DFU transition confirmed${triggerError ? ` after serial disconnect: ${triggerError}` : ''}`);
        return { device, triggered: true, triggerError };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`CDC trigger did not produce the selected DFU device${triggerError ? `: ${triggerError}` : ''}`);
  }

  /** @param {Uint8Array} data @param {{path?:string,trigger?:boolean,verifyReadback?:boolean,leave?:boolean}} [options] */
  async writeFlash(data, options = {}) {
    const profile = this.options.profile;
    validateCortexMImage(data, profile);
    const entered = await this.enterDfu(options);
    const serialNumber = entered.device.serialNumber;
    const session = await openDfuDevice(entered.device, profile);
    const programmer = new UsbDfuProgrammer({ transport: session.transport, ...session.descriptor, profile, sectors: session.sectors, onProgress: this.options.onProgress });
    let result;
    let manifestation;
    let leaveError;
    try {
      result = await programmer.writeFlash([{ address: profile.address, data }], { verifyReadback: options.verifyReadback ?? true, leave: false });
      if (options.leave !== false) {
        try { manifestation = await programmer.leave(profile.address); }
        catch (error) { leaveError = error instanceof Error ? error.message : String(error); }
      }
    } finally { try { await session.close(); } catch (error) { this.options.onLog?.(`USB close after transfer: ${error instanceof Error ? error.message : String(error)}`); } }
    if (options.leave !== false) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const cdc = await this.findCdc();
        if (cdc && (!serialNumber || cdc.serialNumber === serialNumber)) return { ...result, manifestation: manifestation ?? { state: 'disconnected-confirmed', disconnected: true }, chip: 'STM32 CDC-DFU', serialNumber, triggered: entered.triggered, reboot: { confirmed: true, path: cdc.path, manifestation, leaveError } };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Flash transfer completed but application CDC return was not confirmed${leaveError ? `: ${leaveError}` : ''}`);
    }
    return { ...result, chip: 'USB DFU target', serialNumber, triggered: entered.triggered, reboot: { confirmed: false } };
  }
}
