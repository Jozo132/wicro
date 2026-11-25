import { parseDfuFunctionalDescriptor, parseDfuseMemory } from './dfu.js';

/**
 * WebUSB transport also used by Node through the usb package's WebUSB adapter.
 * @param {any} device
 * @param {{interfaceNumber?:number,alternateSetting?:number}} [selection]
 */
export const openDfuDevice = async (device, selection = {}) => {
  await device.open();
  try {
    if (!device.configuration) await device.selectConfiguration(device.configurations[0].configurationValue);
    const candidates = [];
    for (const iface of device.configuration.interfaces) for (const alternate of iface.alternates) {
      if (alternate.interfaceClass === 0xfe && alternate.interfaceSubclass === 1 && alternate.interfaceProtocol === 2 && (selection.interfaceNumber === undefined || iface.interfaceNumber === selection.interfaceNumber) && (selection.alternateSetting === undefined || alternate.alternateSetting === selection.alternateSetting)) candidates.push({ iface, alternate });
    }
    if (candidates.length !== 1) throw new Error(`Select an explicit DFU interface/alternate; found ${candidates.length} matching targets`);
    const { iface, alternate } = candidates[0];
    await device.claimInterface(iface.interfaceNumber);
    await device.selectAlternateInterface(iface.interfaceNumber, alternate.alternateSetting);
    /** @param {any} setup @param {number} length */
    const controlIn = async (setup, length) => {
      const result = await device.controlTransferIn(setup, length);
      if (result.status !== 'ok' || !result.data) throw new Error(`USB control read failed: ${result.status}`);
      return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
    };
    const configIndex = device.configurations.findIndex((/** @type {any} */ config) => config.configurationValue === device.configuration.configurationValue);
    const setup = { requestType: 'standard', recipient: 'device', request: 6, value: 0x0200 | configIndex, index: 0 };
    const header = await controlIn(setup, 9);
    if (header.length < 9) throw new Error('Truncated USB configuration header');
    const total = header[2] | (header[3] << 8);
    const descriptorBytes = await controlIn(setup, total);
    if (descriptorBytes.length !== total) throw new Error('Truncated USB configuration descriptor');
    const descriptor = parseDfuFunctionalDescriptor(descriptorBytes, iface.interfaceNumber, alternate.alternateSetting);
    const name = String(alternate.interfaceName ?? '');
    return {
      device, descriptor, name, interfaceNumber: iface.interfaceNumber, alternateSetting: alternate.alternateSetting,
      sectors: name.startsWith('@') ? parseDfuseMemory(name) : [],
      transport: {
        /** @param {number} request @param {number} value @param {number} length */
        in: (request, value, length) => controlIn({ requestType: 'class', recipient: 'interface', request, value, index: iface.interfaceNumber }, length),
        /** @param {number} request @param {number} value @param {Uint8Array} bytes */
        out: async (request, value, bytes) => {
          const result = await device.controlTransferOut({ requestType: 'class', recipient: 'interface', request, value, index: iface.interfaceNumber }, Uint8Array.from(bytes));
          if (result.status !== 'ok' || result.bytesWritten !== bytes.length) throw new Error(`USB control write failed or was short: ${result.status}`);
        },
        reset: async () => { await device.reset(); }
      },
      close: async () => { await device.close(); }
    };
  } catch (error) { await device.close(); throw error; }
};
