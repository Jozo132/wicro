/** @typedef {{in:(request:number,value:number,length:number)=>Promise<Uint8Array>,out:(request:number,value:number,data:Uint8Array)=>Promise<void>,reset?:()=>Promise<void>}} DfuTransport */
/** @typedef {{address:number,capacity:number,protocol:'dfuse'|'dfu'}} DfuMemoryProfile */
/** @typedef {{address:number,size:number,readable:boolean,erasable:boolean,writable:boolean}} DfuSector */

/** @param {number} command @param {number} address */
export const dfuseAddressCommand = (command, address) => {
  if (![0x21, 0x41].includes(command) || !Number.isInteger(address) || address < 0 || address > 0xffffffff) throw new Error('Invalid DfuSe address command');
  const bytes = new Uint8Array(5);
  bytes[0] = command;
  new DataView(bytes.buffer).setUint32(1, address, true);
  return bytes;
};

/** @param {Uint8Array} bytes */
export const parseDfuStatus = (bytes) => {
  if (bytes.length !== 6) throw new Error('DFU_GETSTATUS must return exactly six bytes');
  return { status: bytes[0], pollTimeoutMs: bytes[1] | (bytes[2] << 8) | (bytes[3] << 16), state: bytes[4], stringIndex: bytes[5] };
};

/** @param {Uint8Array} bytes @param {number} interfaceNumber @param {number} alternateSetting */
export const parseDfuFunctionalDescriptor = (bytes, interfaceNumber, alternateSetting) => {
  let matching = false;
  for (let offset = 0; offset + 2 <= bytes.length;) {
    const length = bytes[offset];
    if (length < 2 || offset + length > bytes.length) throw new Error('Malformed USB configuration descriptor');
    const type = bytes[offset + 1];
    if (type === 4 && length >= 9) matching = bytes[offset + 2] === interfaceNumber && bytes[offset + 5] === 0xfe && bytes[offset + 6] === 1 && bytes[offset + 7] === 2;
    if (type === 0x21 && matching && length >= 9) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset, length);
      const transferSize = view.getUint16(5, true);
      if (!transferSize) throw new Error('DFU descriptor advertises a zero transfer size');
      return { attributes: bytes[offset + 2], transferSize, version: view.getUint16(7, true) };
    }
    offset += length;
  }
  throw new Error('DFU functional descriptor not found for the selected interface/alternate');
};

/** Parse the DfuSe alternate's actual memory geometry; never guess sector sizes. @param {string} description @returns {DfuSector[]} */
export const parseDfuseMemory = (description) => {
  if (!description.startsWith('@')) throw new Error('Selected DfuSe alternate does not advertise a memory map');
  const parts = description.split('/');
  /** @type {DfuSector[]} */
  const sectors = [];
  for (let index = 1; index + 1 < parts.length; index += 2) {
    let address = Number(parts[index].trim());
    if (!Number.isInteger(address) || address < 0 || address > 0xffffffff) throw new Error('Invalid DfuSe memory base');
    for (const group of parts[index + 1].split(',')) {
      const match = group.trim().match(/^(\d+)\s*\*\s*(\d+)\s*([BKM])([a-g])$/i);
      if (!match) throw new Error(`Unsupported DfuSe memory geometry: ${group}`);
      const count = Number(match[1]);
      const size = Number(match[2]) * ({ B: 1, K: 1024, M: 1048576 }[match[3].toUpperCase()] ?? 0);
      const permissions = match[4].toLowerCase().charCodeAt(0) - 96;
      if (count < 1 || count > 65536 || size < 1 || address + count * size > 0x100000000) throw new Error('DfuSe memory geometry exceeds address space');
      for (let page = 0; page < count; page++) {
        sectors.push({ address, size, readable: Boolean(permissions & 1), erasable: Boolean(permissions & 2), writable: Boolean(permissions & 4) });
        address += size;
      }
    }
  }
  if (!sectors.length) throw new Error('DfuSe memory map is empty');
  return sectors;
};

/** @param {{address:number,data:Uint8Array}[]} files @param {DfuMemoryProfile} profile @param {DfuSector[]} sectors @param {boolean} verify */
export const planDfuWrite = (files, profile, sectors, verify) => {
  if (!['dfuse', 'dfu'].includes(profile.protocol)) throw new Error('An explicit supported DFU protocol is required');
  if (!Number.isInteger(profile.address) || !Number.isInteger(profile.capacity) || profile.address < 0 || profile.capacity < 1 || profile.address + profile.capacity > 0x100000000) throw new Error('An explicit valid DFU application address/capacity is required');
  if (!files.length) throw new Error('DFU firmware bytes are required');
  const sorted = [...files].sort((a, b) => a.address - b.address);
  let lastEnd = -1;
  const erase = new Map();
  for (const file of sorted) {
    const end = file.address + file.data.length;
    if (!(file.data instanceof Uint8Array) || !file.data.length || !Number.isInteger(file.address) || file.address < profile.address || end > profile.address + profile.capacity || file.address < lastEnd) throw new Error('DFU image is empty, overlapping, or outside the application region');
    lastEnd = end;
    if (profile.protocol === 'dfu') {
      if (files.length !== 1 || file.address !== profile.address) throw new Error('Standard DFU requires one contiguous image at the explicitly configured bootloader base');
      continue;
    }
    let covered = file.address;
    for (const sector of [...sectors].sort((a, b) => a.address - b.address)) {
      if (sector.address >= end || sector.address + sector.size <= file.address) continue;
      if (sector.address > covered || !sector.writable || !sector.erasable || verify && !sector.readable) throw new Error('Image crosses a gap or a protected/unreadable DfuSe region');
      if (sector.address < profile.address || sector.address + sector.size > profile.address + profile.capacity) throw new Error('Page erase would cross the application boundary; adjust the image/layout before uploading');
      covered = Math.max(covered, sector.address + sector.size);
      erase.set(sector.address, sector);
    }
    if (covered < end) throw new Error('DFU image is not covered by the selected memory map');
  }
  return { files: sorted, erase: [...erase.values()].sort((a, b) => a.address - b.address), bytes: sorted.reduce((sum, file) => sum + file.data.length, 0) };
};

export class UsbDfuProgrammer {
  /** @param {{transport:DfuTransport,transferSize:number,attributes:number,profile:DfuMemoryProfile,sectors?:DfuSector[],timeoutMs?:number,onProgress?:(event:{stage:string,message:string,percent:number})=>void}} options */
  constructor(options) {
    if (!Number.isInteger(options.transferSize) || options.transferSize < 1 || options.transferSize > 65535) throw new Error('Invalid DFU transfer size');
    this.options = options;
  }

  async status() {
    const status = parseDfuStatus(await this.options.transport.in(3, 0, 6));
    if (status.status !== 0 || status.state === 10) throw new Error(`DFU device error: status=${status.status}, state=${status.state}`);
    return status;
  }

  async idle() {
    const bytes = parseDfuStatus(await this.options.transport.in(3, 0, 6));
    if (bytes.state === 10) await this.options.transport.out(4, 0, new Uint8Array());
    else if ([5, 9].includes(bytes.state)) await this.options.transport.out(6, 0, new Uint8Array());
    const status = await this.status();
    if (status.state !== 2) throw new Error(`DFU device is not idle (state ${status.state})`);
  }

  /** @param {number} block @param {Uint8Array} bytes */
  async download(block, bytes) {
    if (block > 65535) throw new Error('Image exceeds DFU block address space');
    await this.options.transport.out(1, block, bytes);
    const deadline = Date.now() + (this.options.timeoutMs ?? 30000);
    while (Date.now() < deadline) {
      const status = await this.status();
      if (status.state === 5) return;
      if (![3, 4].includes(status.state)) throw new Error(`Unexpected DFU download state ${status.state}`);
      if (Date.now() + status.pollTimeoutMs > deadline) throw new Error('DFU operation exceeded its timeout');
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, status.pollTimeoutMs)));
    }
    throw new Error('DFU operation timed out');
  }

  /** Read DfuSe memory without erase/program commands. @param {number} address @param {number} length */
  async readMemory(address, length) {
    if (this.options.profile.protocol !== 'dfuse' || !(this.options.attributes & 2)) throw new Error('DfuSe readback is not supported by this device/profile');
    const profile = this.options.profile;
    if (!Number.isInteger(address) || !Number.isInteger(length) || length < 1 || address < profile.address || address + length > profile.address + profile.capacity) throw new Error('Read is outside the configured application region');
    const bytes = new Uint8Array(length);
    await this.idle();
    for (let offset = 0; offset < length; offset += this.options.transferSize) {
      await this.download(0, dfuseAddressCommand(0x21, address + offset));
      await this.idle();
      const size = Math.min(this.options.transferSize, length - offset);
      const chunk = await this.options.transport.in(2, 2, size);
      if (chunk.length !== size) throw new Error(`Short DFU read at 0x${(address + offset).toString(16)}`);
      bytes.set(chunk, offset);
      await this.idle();
    }
    return bytes;
  }

  /** Request manifestation; a USB disconnect requires separate enumeration confirmation. @param {number} address @param {number} [block] */
  async leave(address, block = 0) {
    await this.idle();
    if (this.options.profile.protocol === 'dfuse') await this.download(0, dfuseAddressCommand(0x21, address));
    await this.options.transport.out(1, block, new Uint8Array());
    try {
      const status = await this.status();
      if (![6, 7, 8, 2].includes(status.state)) throw new Error(`Unexpected DFU manifestation state ${status.state}`);
      if (status.state === 8 && this.options.transport.reset) await this.options.transport.reset();
      return { state: status.state === 2 ? 'complete' : 'accepted', disconnected: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/LIBUSB_ERROR_NO_DEVICE|device.*disconnected|device.*not found|transfer.*cancelled/i.test(message) && !(error instanceof Error && error.name === 'NetworkError')) throw error;
      return { state: 'disconnected-unconfirmed', disconnected: true, error: message };
    }
  }

  /** @param {{address:number,data:Uint8Array}[]} files @param {{verifyReadback?:boolean,leave?:boolean}} [options] */
  async writeFlash(files, options = {}) {
    const { transport, profile, transferSize, attributes } = this.options;
    if (!(attributes & 1)) throw new Error('DFU device does not support firmware downloads');
    if (options.verifyReadback && !(attributes & 2)) throw new Error('DFU upload/readback is unavailable; no erase has been performed');
    const plan = planDfuWrite(files, profile, this.options.sectors ?? [], Boolean(options.verifyReadback));
    if (plan.files.some((file) => Math.ceil(file.data.length / transferSize) + 2 > 65535)) throw new Error('Image exceeds DFU block address space');
    await this.idle();
    for (const [index, sector] of plan.erase.entries()) {
      this.options.onProgress?.({ stage: 'erase', message: `Erasing page 0x${sector.address.toString(16)}`, percent: Math.round(index / plan.erase.length * 20) });
      await this.download(0, dfuseAddressCommand(0x41, sector.address));
    }
    let written = 0;
    for (const file of plan.files) {
      for (let offset = 0, block = profile.protocol === 'dfuse' ? 2 : 0; offset < file.data.length; offset += transferSize, block++) {
        if (profile.protocol === 'dfuse') await this.download(0, dfuseAddressCommand(0x21, file.address + offset));
        await this.download(profile.protocol === 'dfuse' ? 2 : block, file.data.subarray(offset, offset + transferSize));
        written += Math.min(transferSize, file.data.length - offset);
        this.options.onProgress?.({ stage: 'write', message: `Written ${written}/${plan.bytes} bytes`, percent: 20 + Math.round(written / plan.bytes * 60) });
      }
    }
    if (options.verifyReadback) {
      for (const file of plan.files) {
        await this.idle();
        if (profile.protocol === 'dfuse') {
          // Set the address for every read chunk: STM32 computes upload offsets
          // using the requested wLength, including a short final read.
          for (let offset = 0; offset < file.data.length; offset += transferSize) {
            await this.download(0, dfuseAddressCommand(0x21, file.address + offset));
            await this.idle();
            const length = Math.min(transferSize, file.data.length - offset);
            const bytes = await transport.in(2, 2, length);
            if (bytes.length !== length || !bytes.every((value, index) => value === file.data[offset + index])) throw new Error(`DFU readback mismatch at 0x${(file.address + offset).toString(16)}`);
            await this.idle();
          }
        } else {
          for (let offset = 0, block = 0; offset < file.data.length; offset += transferSize, block++) {
            const length = Math.min(transferSize, file.data.length - offset);
            const bytes = await transport.in(2, block, length);
            if (bytes.length !== length || !bytes.every((value, index) => value === file.data[offset + index])) throw new Error(`DFU readback mismatch at offset ${offset}`);
          }
        }
      }
      this.options.onProgress?.({ stage: 'verify', message: 'Flash readback matched firmware bytes', percent: 95 });
    }
    const manifestation = options.leave === false ? { state: 'not-requested', disconnected: false } : await this.leave(plan.files[0].address, profile.protocol === 'dfuse' ? 0 : Math.ceil(plan.bytes / transferSize));
    return { ok: true, protocol: profile.protocol, bytes: plan.bytes, readback: { verified: Boolean(options.verifyReadback), bytes: options.verifyReadback ? plan.bytes : 0 }, manifestation };
  }
}
