/** original ESP32 ROM image support for explicitly bounded RAM-only firmware.
 * Uses standard Web APIs in Node, browsers and VS Code; no native image tools.
 */
/** @param {number} address @param {number} size */
const inRam = (address, size) => Number.isInteger(address) && Number.isInteger(size) && size > 0 && (
  address >= 0x3ffb0000 && address + size <= 0x3ffbe000 ||
  address >= 0x40080000 && address + size <= 0x40090000
);

/** @param {Uint8Array} image */
export const validateEsp32OriginalImage = (image) => {
  if (image.length < 48 || image.length > 0x7000 || image.length % 16 || image[0] !== 0xe9 || image[1] < 1 || image[1] > 16 || image[2] !== 2 || image[3] !== 0x20 || image[8] !== 0xee || image[12] !== 0 || image[13] !== 0 || image[23] !== 0) throw new Error('Invalid original ESP32 ROM image header');
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const entry = view.getUint32(4, true);
  /** @type {{address:number,length:number}[]} */
  const segments = [];
  let offset = 24;
  let checksum = 0xef;
  for (let index = 0; index < image[1]; index++) {
    if (offset + 8 > image.length) throw new Error('Truncated original ESP32 segment header');
    const address = view.getUint32(offset, true);
    const length = view.getUint32(offset + 4, true);
    offset += 8;
    if (!inRam(address, length) || address % 4 || length % 4 || offset + length > image.length) throw new Error('original ESP32 segment is truncated or outside the supported RAM layout');
    if (segments.some((segment) => address < segment.address + segment.length && address + length > segment.address)) throw new Error('Overlapping original ESP32 image segments');
    for (const byte of image.subarray(offset, offset + length)) checksum ^= byte;
    segments.push({ address, length }); offset += length;
  }
  const checksumOffset = Math.floor(offset / 16) * 16 + 15;
  if (checksumOffset + 1 !== image.length || image[checksumOffset] !== checksum || image.subarray(offset, checksumOffset).some((byte) => byte !== 0)) throw new Error('Invalid original ESP32 image checksum/padding');
  if (!segments.some((segment) => segment.address >= 0x40080000 && entry >= segment.address && entry < segment.address + segment.length)) throw new Error('original ESP32 entry is outside executable IRAM');
  return { valid: true, errors: [], entry, segmentCount: segments.length, checksum };
};

/** Generate a ROM-loadable image; mapped flash/Arduino images require a separate recipe.
 * @param {Uint8Array} elf
 */
export const elfToEsp32OriginalBin = (elf) => {
  if (elf.length < 52) throw new Error('Truncated original ESP32 ELF');
  const view = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  if (view.getUint32(0, true) !== 0x464c457f || elf[4] !== 1 || elf[5] !== 1 || view.getUint16(18, true) !== 94) throw new Error('Expected little-endian ELF32 Xtensa firmware');
  const start = view.getUint32(32, true), stride = view.getUint16(46, true), count = view.getUint16(48, true);
  if (!start || stride < 40 || !count || start + stride * count > elf.length) throw new Error('Invalid original ESP32 ELF section table');
  /** @type {{address:number,data:Uint8Array}[]} */
  const segments = [];
  for (let index = 0; index < count; index++) {
    const at = start + index * stride;
    const type = view.getUint32(at + 4, true), flags = view.getUint32(at + 8, true), address = view.getUint32(at + 12, true);
    const offset = view.getUint32(at + 16, true), size = view.getUint32(at + 20, true);
    if (type === 8 || !(flags & 2) || !size) continue;
    const length = Math.ceil(size / 4) * 4;
    if (offset + size > elf.length || address % 4 || !inRam(address, length)) throw new Error('ELF needs an unsupported original ESP32 memory/image recipe');
    const data = new Uint8Array(length); data.set(elf.subarray(offset, offset + size));
    segments.push({ address, data });
  }
  segments.sort((a, b) => a.address - b.address);
  if (!segments.length || segments.length > 16) throw new Error('Invalid original ESP32 loadable segment count');
  const length = 24 + segments.reduce((sum, segment) => sum + 8 + segment.data.length, 0);
  const image = new Uint8Array(Math.floor(length / 16) * 16 + 16);
  const output = new DataView(image.buffer);
  image.set([0xe9, segments.length, 2, 0x20]); // DIO, 40 MHz, 4 MiB.
  image[8] = 0xee; // No remapped flash WP pin. Chip ID 0, no appended hash.
  output.setUint32(4, view.getUint32(24, true), true);
  let position = 24, checksum = 0xef;
  for (const segment of segments) {
    output.setUint32(position, segment.address, true); output.setUint32(position + 4, segment.data.length, true);
    image.set(segment.data, position + 8); position += 8 + segment.data.length;
    for (const byte of segment.data) checksum ^= byte;
  }
  image[image.length - 1] = checksum;
  validateEsp32OriginalImage(image);
  return image;
};
