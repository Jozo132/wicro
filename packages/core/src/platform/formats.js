import { elfToRp2040Bin, validateRp2040Image, rp2040BinToUf2, rp2040Uf2ToBin } from '../../../runtime/src/rp2040-image.js';
import { elfToEsp32OriginalBin, validateEsp32OriginalImage } from '../../../runtime/src/esp32-original-image.js';
import { elfToAvrBin } from '../../../runtime/src/avr-image.js';
import { elfToEsp8266Bin, validateEsp8266Image } from '../../../runtime/src/esp8266-image.js';
import { elfToEsp32Bin, validateEsp32Image } from '../../../runtime/src/elf-utils.js';

/** @param {Uint8Array} elf @param {number} minAddress */
const extractFlatBinaryFromElf = (elf, minAddress = 0x08000000) => {
  const view = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  if (elf.length < 52 || view.getUint32(0, true) !== 0x464c457f) {
    throw new Error('Invalid ELF32 image');
  }
  const shoff = view.getUint32(32, true);
  const shent = view.getUint16(46, true);
  const shnum = view.getUint16(48, true);
  if (shoff === 0 || shent < 40 || shnum === 0) {
    throw new Error('ELF image has no section table');
  }

  /** @type {Array<{addr:number,off:number,size:number}>} */
  const slices = [];
  for (let i = 0; i < shnum; i++) {
    const pos = shoff + i * shent;
    if (pos + 40 > elf.length) break;
    const type = view.getUint32(pos + 4, true);
    const flags = view.getUint32(pos + 8, true);
    const addr = view.getUint32(pos + 12, true);
    const off = view.getUint32(pos + 16, true);
    const size = view.getUint32(pos + 20, true);
    if (type === 8 || (flags & 2) === 0 || size === 0 || addr < minAddress) continue;
    if (off + size > elf.length) continue;
    slices.push({ addr, off, size });
  }
  if (slices.length === 0) throw new Error('ELF image has no loadable flash sections');

  const base = Math.min(...slices.map((s) => s.addr));
  const limit = Math.max(...slices.map((s) => s.addr + s.size));
  const out = new Uint8Array(limit - base);
  for (const s of slices) out.set(elf.subarray(s.off, s.off + s.size), s.addr - base);
  return { base, data: out };
};

/** @param {number} count @param {number} addr @param {number} type @param {Uint8Array} payload */
const formatHexRecord = (count, addr, type, payload) => {
  const bytes = [count, (addr >> 8) & 0xff, addr & 0xff, type, ...payload];
  const sum = bytes.reduce((acc, value) => (acc + value) & 0xff, 0);
  const check = (-sum) & 0xff;
  return `:${[...bytes, check].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('')}`;
};

/** @param {Uint8Array} data @param {number} baseAddress */
const encodeIntelHex = (data, baseAddress) => {
  const lines = [];
  let upper = -1;
  for (let offset = 0; offset < data.length; offset += 16) {
    const abs = baseAddress + offset;
    const high = (abs >>> 16) & 0xffff;
    if (high !== upper) {
      upper = high;
      lines.push(formatHexRecord(2, 0, 4, new Uint8Array([(high >> 8) & 0xff, high & 0xff])));
    }
    const chunk = data.subarray(offset, Math.min(offset + 16, data.length));
    lines.push(formatHexRecord(chunk.length, abs & 0xffff, 0, chunk));
  }
  lines.push(':00000001FF');
  return new TextEncoder().encode(`${lines.join('\n')}\n`);
};

/** @param {Uint8Array} data @param {number} baseAddress @param {number} familyId */
const encodeUf2 = (data, baseAddress, familyId) => {
  const blockSize = 256;
  const count = Math.max(1, Math.ceil(data.length / blockSize));
  const out = new Uint8Array(count * 512);
  const view = new DataView(out.buffer);
  for (let index = 0; index < count; index++) {
    const start = index * 512;
    const slice = data.subarray(index * blockSize, Math.min((index + 1) * blockSize, data.length));
    view.setUint32(start + 0, 0x0a324655, true);
    view.setUint32(start + 4, 0x9e5d5157, true);
    view.setUint32(start + 8, familyId ? 0x00002000 : 0, true);
    view.setUint32(start + 12, baseAddress + index * blockSize, true);
    view.setUint32(start + 16, slice.length, true);
    view.setUint32(start + 20, index, true);
    view.setUint32(start + 24, count, true);
    view.setUint32(start + 28, familyId, true);
    out.set(slice, start + 32);
    view.setUint32(start + 508, 0x0ab16f30, true);
  }
  return out;
};

/** @type {import('./registry.js').FirmwareFormatHandler} */
export const elfFormatHandler = Object.freeze({
  id: 'elf',
  extension: '.elf',
  description: 'ELF32 executable image',
  convert: (elf) => new Uint8Array(elf),
  validate: (image) => {
    const ok = image.length >= 52 && image[0] === 0x7f && image[1] === 0x45 && image[2] === 0x4c && image[3] === 0x46;
    return { valid: ok, errors: ok ? [] : ['Invalid ELF magic header'] };
  }
});

/** @param {Record<string, unknown>} options @param {number} fallback */
const resolveBaseAddress = (options, fallback) => {
  if (typeof options.baseAddress === 'number') return options.baseAddress;
  if (typeof options.flashAddress === 'number') return options.flashAddress;
  if (typeof options.flashAddress === 'string') {
    const parsed = Number.parseInt(options.flashAddress, 16);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

/** @type {import('./registry.js').FirmwareFormatHandler} */
export const flatBinFormatHandler = Object.freeze({
  id: 'bin',
  extension: '.bin',
  description: 'Flat raw flash binary image',
  convert: (elf, options = {}) => extractFlatBinaryFromElf(elf, resolveBaseAddress(options, 0x08000000)).data,
  validate: (image) => ({
    valid: image.length > 0,
    errors: image.length > 0 ? [] : ['Binary firmware image is empty']
  })
});

/** @type {import('./registry.js').FirmwareFormatHandler} */
export const intelHexFormatHandler = Object.freeze({
  id: 'hex',
  extension: '.hex',
  description: 'Intel HEX firmware image',
  convert: (elf, options = {}) => {
    const flat = extractFlatBinaryFromElf(elf, resolveBaseAddress(options, 0x08000000));
    return encodeIntelHex(flat.data, flat.base);
  },
  validate: (image) => {
    const text = new TextDecoder().decode(image).trim();
    const lines = text.split(/\r?\n/).filter(Boolean);
    const errors = [];
    if (lines.length === 0) errors.push('Intel HEX image is empty');
    if (lines.length > 0 && lines[lines.length - 1] !== ':00000001FF') errors.push('Missing Intel HEX EOF record');
    for (const line of lines) {
      if (!line.startsWith(':') || line.length < 11) {
        errors.push(`Malformed Intel HEX record: ${line}`);
        break;
      }
    }
    return { valid: errors.length === 0, errors };
  }
});

/** @type {import('./registry.js').FirmwareFormatHandler} */
export const uf2FormatHandler = Object.freeze({
  id: 'uf2',
  extension: '.uf2',
  description: 'Microsoft UF2 bootloader image',
  convert: (elf, options = {}) => {
    const familyId = typeof options.familyId === 'number' ? options.familyId : 0x5ee21072;
    const flat = extractFlatBinaryFromElf(elf, resolveBaseAddress(options, 0x08000000));
    return encodeUf2(flat.data, flat.base, familyId);
  },
  validate: (image) => {
    const errors = [];
    if (image.length === 0 || image.length % 512 !== 0) errors.push('UF2 size must be a non-zero multiple of 512 bytes');
    if (image.length >= 512) {
      const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
      if (view.getUint32(0, true) !== 0x0a324655 || view.getUint32(4, true) !== 0x9e5d5157 || view.getUint32(508, true) !== 0x0ab16f30) {
        errors.push('Invalid UF2 block magic numbers');
      }
    }
    return { valid: errors.length === 0, errors };
  }
});

/** @type {import('./registry.js').FirmwareFormatHandler} */
export const esp32C3BinFormatHandler = Object.freeze({
  id: 'esp32-c3-bin',
  extension: '.bin',
  description: 'Espressif ESP32-C3 64 KB MMU-aligned application image',
  convert: async (elf) => elfToEsp32Bin(elf),
  validate: async (image) => {
    const result = await validateEsp32Image(image);
    const errors = [...result.errors];
    if (result.valid && !result.hasAppDesc) {
      errors.push('Generated ESP32-C3 firmware image is missing esp_app_desc_t metadata in DROM');
    }
    return { ...result, valid: errors.length === 0, errors };
  }
});

/** @type {import('./registry.js').FirmwareFormatHandler} */
export const esp8266RomFormatHandler = Object.freeze({
  id: 'esp8266-rom', extension: '.bin', description: 'ESP8266 RAM-only ROM boot image',
  convert: (elf) => elfToEsp8266Bin(elf),
  validate: (image) => { try { return validateEsp8266Image(image); } catch (error) { return { valid: false, errors: [error instanceof Error ? error.message : String(error)] }; } }
});

/** @type {import('./registry.js').FirmwareFormatHandler} */
export const avrBinFormatHandler = Object.freeze({
  id: 'avr-bin', extension: '.bin', description: 'AVR Nano application flash bytes', convert: (elf) => elfToAvrBin(elf),
  validate: (image) => ({ valid: image.length >= 4 && image.length <= 30720, errors: image.length >= 4 && image.length <= 30720 ? [] : ['AVR image crosses application bounds'] })
});

/** @type {import('./registry.js').FirmwareFormatHandler} */
export const rp2040BinFormatHandler = Object.freeze({ id: 'rp2040-bin', extension: '.bin', description: 'RP2040-Zero boot2 flash image', convert: (elf) => elfToRp2040Bin(elf), validate: (bytes) => { try { return validateRp2040Image(bytes); } catch (error) { return { valid: false, errors: [String(error)] }; } } });
/** @type {import('./registry.js').FirmwareFormatHandler} */
export const rp2040Uf2FormatHandler = Object.freeze({ id: 'rp2040-uf2', extension: '.uf2', description: 'RP2040 family UF2', convert: async (elf) => rp2040BinToUf2(await elfToRp2040Bin(elf)), validate: (bytes) => { try { return validateRp2040Image(rp2040Uf2ToBin(bytes)); } catch (error) { return { valid: false, errors: [String(error)] }; } } });

/** @type {import('./registry.js').FirmwareFormatHandler} */
export const esp32OriginalRomFormatHandler = Object.freeze({
  id: 'esp32-original-rom', extension: '.bin', description: 'Original ESP32 RAM-only ROM boot image at 0x1000',
  convert: (elf) => elfToEsp32OriginalBin(elf),
  validate: (bytes) => { try { return validateEsp32OriginalImage(bytes); } catch (error) { return { valid: false, errors: [String(error)] }; } }
});

export const BUILTIN_FIRMWARE_FORMATS = Object.freeze([esp32OriginalRomFormatHandler, rp2040BinFormatHandler, rp2040Uf2FormatHandler, avrBinFormatHandler, esp8266RomFormatHandler,
  elfFormatHandler,
  flatBinFormatHandler,
  intelHexFormatHandler,
  uf2FormatHandler,
  esp32C3BinFormatHandler
]);
