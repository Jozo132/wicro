/** ST-LINK/V2 API v2 over the WebUSB contract, shared by Node and browsers.
 * Wire commands follow ST-Link/OpenOCD protocol definitions. Flash sequencing
 * follows ST PM0075; no native helper, RAM loader or option-byte writes.
 */
const pause = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const STLINK_PRODUCT_IDS = Object.freeze([0x3748, 0x374b, 0x3752]);

/** Normalize V2 binary-code-unit serials, including embedded NULs, and V2.1 ASCII hex serials.
 * @param {Uint8Array} bytes
 */
export const parseStLinkSerialDescriptor = (bytes) => {
  if (bytes.length < 4 || bytes[0] !== bytes.length || bytes[1] !== 3 || bytes.length % 2) throw new Error('Malformed ST-Link serial descriptor');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), units = [];
  for (let at = 2; at < bytes.length; at += 2) units.push(view.getUint16(at, true));
  if (units.length === 12 && units.every((unit) => unit <= 255)) return units.map((unit) => unit.toString(16).padStart(2, '0')).join('');
  const serial = String.fromCharCode(...units);
  if (!/^[0-9a-f]{24}$/i.test(serial)) throw new Error('Unsupported ST-Link serial descriptor');
  return serial.toLowerCase();
};

/** Device must already be open. @param {any} device */
export const readStLinkSerial = async (device) => {
  const request = { requestType: 'standard', recipient: 'device', request: 6, index: 0, value: 0x100 };
  const descriptor = await device.controlTransferIn(request, 18);
  if (descriptor.status !== 'ok' || descriptor.data?.byteLength !== 18) throw new Error('ST-Link device descriptor is unavailable');
  const index = descriptor.data.getUint8(16);
  if (!index) throw new Error('ST-Link has no serial descriptor');
  const serial = await device.controlTransferIn({ ...request, index: 0x409, value: 0x300 | index }, 255);
  if (serial.status !== 'ok' || !serial.data) throw new Error('ST-Link serial descriptor is unavailable');
  return parseStLinkSerialDescriptor(new Uint8Array(serial.data.buffer, serial.data.byteOffset, serial.data.byteLength));
};

/** @param {number} command @param {number} address @param {number} length */
export const stlinkMemoryPacket = (command, address, length) => {
  const alignment = command === 0x48 ? 2 : 4;
  if (![7, 8, 0x48].includes(command) || !Number.isInteger(address) || address < 0 || address > 0xffffffff || address % alignment || !Number.isInteger(length) || length < alignment || length > 1024 || length % alignment || address + length > 0x100000000 || (address & 1023) + length > 1024) throw new Error('Invalid ST-Link aligned memory transfer or 1 KiB boundary');
  const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
  bytes.set([0xf2, command]); view.setUint32(2, address, true); view.setUint16(6, length, true);
  return bytes;
};

/** @param {Uint8Array} image @param {number} capacity */
export const validateStm32F103Image = (image, capacity = 65536) => {
  if (![65536, 131072].includes(capacity) || image.length < 64 || image.length > capacity) throw new Error('STM32F103 image exceeds its explicit C8/CB profile or lacks core vectors');
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const stack = view.getUint32(0, true), reset = view.getUint32(4, true);
  if (stack <= 0x20000000 || stack > 0x20005000 || stack % 8) throw new Error('STM32F103 initial stack is outside 20 KiB SRAM');
  if (!(reset & 1) || reset < 0x08000040 || reset - 1 >= 0x08000000 + image.length) throw new Error('STM32F103 Thumb reset vector is outside this image');
  return { stack, reset };
};

export class StLinkProbe {
  /** @param {{device:any,onProgress?:(event:{stage:string,message:string,percent:number})=>void}} options */
  constructor(options) { this.options = options; this.input = 1; this.output = 2; }
  /** @param {Uint8Array} bytes */
  async out(bytes) {
    const result = await this.options.device.transferOut(this.output, Uint8Array.from(bytes));
    if (result.status !== 'ok' || result.bytesWritten !== bytes.length) throw new Error('Short or failed ST-Link USB write');
  }
  /** @param {number} length */
  async inputBytes(length) {
    const result = await this.options.device.transferIn(this.input, length);
    if (result.status !== 'ok' || !result.data || result.data.byteLength !== length) throw new Error('Short or failed ST-Link USB read');
    return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
  }
  /** @param {number[]|Uint8Array} command @param {number} length */
  async command(command, length) {
    if (command.length > 16) throw new Error('ST-Link commands are at most 16 bytes');
    const bytes = new Uint8Array(16); bytes.set(command); await this.out(bytes);
    return this.inputBytes(length);
  }
  /** @param {Uint8Array} response */
  checkStatus(response) { if (response[0] !== 0x80) throw new Error(`ST-Link command failed: status 0x${response[0].toString(16)} (check target power/SWD wiring)`); }
  async open() {
    const device = this.options.device;
    if (device.vendorId !== 0x0483 || !STLINK_PRODUCT_IDS.includes(device.productId)) throw new Error('Select a supported ST-LINK/V2 or V2.1 probe');
    await device.open();
    try {
      if (!device.configuration) await device.selectConfiguration(1);
      this.serialNumber = await readStLinkSerial(device);
      const iface = device.configuration.interfaces.find((/** @type {any} */ entry) => entry.alternate.interfaceClass === 255 && entry.alternate.endpoints.some((/** @type {any} */ ep) => ep.type === 'bulk' && ep.direction === 'out'));
      if (!iface) throw new Error('ST-Link debug interface is missing');
      const endpoints = iface.alternate.endpoints;
      this.output = endpoints.find((/** @type {any} */ ep) => ep.type === 'bulk' && ep.direction === 'out').endpointNumber;
      this.input = endpoints.find((/** @type {any} */ ep) => ep.type === 'bulk' && ep.direction === 'in' && ep.endpointNumber === 1)?.endpointNumber;
      if (!this.input) throw new Error('ST-Link reply endpoint is missing');
      await device.claimInterface(iface.interfaceNumber);
      const version = await this.command([0xf1], 6), bits = version[0] << 8 | version[1];
      this.version = { major: bits >>> 12, jtag: bits >>> 6 & 63, swim: bits & 63 };
      if (this.version.major !== 2 || this.version.jtag < 26) throw new Error('ST-Link V2 J26 or newer is required for this half-word flash implementation');
      const voltage = await this.command([0xf7], 8), view = new DataView(voltage.buffer, voltage.byteOffset, voltage.byteLength);
      const factor = view.getUint32(0, true);
      this.voltage = factor ? 2.4 * view.getUint32(4, true) / factor : 0;
      if (this.voltage < 2.7 || this.voltage > 3.6) throw new Error(`Target voltage ${this.voltage.toFixed(2)} V is outside this flash profile`);
      this.checkStatus(await this.command([0xf2, 0x3c, 1], 2)); // Release NRST.
      this.checkStatus(await this.command([0xf2, 0x43, 40, 0], 2)); // 100 kHz SWD.
      this.checkStatus(await this.command([0xf2, 0x30, 0xa3], 2));
    } catch (error) { await device.close(); throw error; }
  }
  /** @param {number} address */
  async read32(address) {
    const bytes = new Uint8Array(6); bytes.set([0xf2, 0x36]); new DataView(bytes.buffer).setUint32(2, address, true);
    const result = await this.command(bytes, 8); this.checkStatus(result);
    return new DataView(result.buffer, result.byteOffset, result.byteLength).getUint32(4, true);
  }
  /** @param {number} address @param {number} value */
  async write32(address, value) {
    const bytes = new Uint8Array(10), view = new DataView(bytes.buffer); bytes.set([0xf2, 0x35]);
    view.setUint32(2, address, true); view.setUint32(6, value, true);
    this.checkStatus(await this.command(bytes, 2));
  }
  async memoryStatus() { this.checkStatus(await this.command([0xf2, 0x3e], 12)); }
  /** @param {number} address @param {number} length */
  async readMemory(address, length) {
    if (!Number.isInteger(length) || length < 4 || length % 4 || length > 131072 || address % 4) throw new Error('ST-Link reads require aligned words and bounded length');
    const bytes = new Uint8Array(length);
    for (let offset = 0; offset < length;) {
      const size = Math.min(length - offset, 1024 - ((address + offset) & 1023));
      await this.out(stlinkMemoryPacket(7, address + offset, size));
      bytes.set(await this.inputBytes(size), offset); await this.memoryStatus(); offset += size;
    }
    return bytes;
  }
  async identify() {
    const cpuid = await this.read32(0xe000ed00), idcode = await this.read32(0xe0042000);
    const capacity = ((await this.read32(0x1ffff7e0)) & 65535) * 1024;
    if ((cpuid >>> 4 & 0xfff) !== 0xc23 || (idcode & 0xfff) !== 0x410 || ![65536, 131072].includes(capacity)) throw new Error('Target is not the supported medium-density Cortex-M3 STM32F103 C8/CB profile');
    const words = [];
    for (const address of [0x1ffff7e8, 0x1ffff7ec, 0x1ffff7f0]) words.push(await this.read32(address));
    return { cpuid, idcode, capacity, pageSize: 1024, sramBytes: 20480, uid: words.map((word) => word.toString(16).padStart(8, '0')).join(''), probeSerial: this.serialNumber, version: this.version, voltage: this.voltage };
  }
  async halt() {
    await this.write32(0xe000edf0, 0xa05f0003);
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) { if ((await this.read32(0xe000edf0)) & 0x20000) return; await pause(5); }
    throw new Error('Cortex-M3 did not halt');
  }
  async resetAndRun() {
    await this.write32(0xe000edfc, 0); // No vector catch.
    await this.write32(0xe000edf0, 0xa05f0001);
    await this.write32(0xe000ed0c, 0x05fa0004);
    await pause(100);
    if ((await this.read32(0xe000edf0)) & 0x20000) throw new Error('Target remained halted after reset');
  }
  async flashReady() {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const status = await this.read32(0x4002200c);
      if (!(status & 1)) { if (status & 0x14) throw new Error(`STM32 flash error 0x${status.toString(16)}`); return; }
      await pause(1);
    }
    throw new Error('STM32 flash busy timeout');
  }
  /** @param {Uint8Array} image @param {{capacity:number,expectedUid?:string,onBackup?:(bytes:Uint8Array)=>Promise<void>}} options */
  async writeFlash(image, options) {
    validateStm32F103Image(image, options.capacity);
    const target = await this.identify();
    if (target.capacity !== options.capacity) throw new Error('Detected flash capacity does not match the selected C8/CB profile');
    if (options.expectedUid && target.uid !== options.expectedUid.toLowerCase()) throw new Error('STM32 UID does not match the selected target');
    if ((await this.read32(0x4002201c)) & 3) throw new Error('STM32 option-byte error or read protection is enabled; no unprotect or mass erase is performed');
    const eraseLength = Math.ceil(image.length / 1024) * 1024;
    const writeProtection = await this.read32(0x40022020);
    for (let page = 0; page < eraseLength / 1024; page++) if (!(writeProtection & (1 << Math.floor(page / 4)))) throw new Error('An occupied flash page is write protected');
    await this.halt();
    if (options.onBackup) await options.onBackup(await this.readMemory(0x08000000, target.capacity));
    await this.write32(0x4002200c, 0x34); // Clear stale EOP/error flags.
    await this.flashReady();
    await this.write32(0x40022004, 0x45670123); await this.write32(0x40022004, 0xcdef89ab);
    if ((await this.read32(0x40022010)) & 0x80) throw new Error('STM32 flash controller did not unlock');
    try {
      for (let offset = 0; offset < eraseLength; offset += 1024) {
        await this.write32(0x40022010, 2); await this.write32(0x40022014, 0x08000000 + offset); await this.write32(0x40022010, 0x42); await this.flashReady();
        const erased = await this.readMemory(0x08000000 + offset, 1024);
        if (erased.some((byte) => byte !== 255)) throw new Error('STM32 page erase verification failed');
      }
      await this.write32(0x40022010, 1);
      for (let offset = 0; offset < image.length; offset += 2) {
        const half = Uint8Array.of(image[offset], image[offset + 1] ?? 255);
        if (half[0] === 255 && half[1] === 255) continue;
        await this.out(stlinkMemoryPacket(0x48, 0x08000000 + offset, 2)); await this.out(half); await this.memoryStatus(); await this.flashReady();
        if (offset % 128 === 0) this.options.onProgress?.({ stage: 'write', message: `STM32 programmed ${offset}/${image.length}`, percent: Math.round(offset / image.length * 90) });
      }
    } finally { await this.write32(0x40022010, 0x80); }
    const readback = await this.readMemory(0x08000000, Math.ceil(image.length / 4) * 4);
    if (!image.every((byte, index) => byte === readback[index])) throw new Error('STM32 complete flash readback mismatch');
    await this.resetAndRun();
    return { ok: true, chip: 'STM32F103', target, readback: { verified: true, bytes: image.length }, eraseLength, reboot: { requested: true, confirmed: false } };
  }
  async close() { await this.options.device.close(); }
}

/** Challenge the example's SRAM mailbox while the CPU runs. @param {StLinkProbe} probe @param {number} nonce */
export const sampleStm32F103Runtime = async (probe, nonce) => {
  await probe.write32(0x20000010, nonce);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const bytes = await probe.readMemory(0x20000000, 32), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0x57463133 || view.getUint32(4, true) !== 1) throw new Error('STM32 runtime mailbox identity mismatch');
    if (view.getUint32(20, true) === nonce) return { milliseconds: view.getUint32(8, true), heartbeat: view.getUint32(12, true), nonce, sequence: view.getUint32(24, true) };
    await pause(1);
  }
  throw new Error('STM32 runtime did not answer the SRAM nonce challenge');
};
