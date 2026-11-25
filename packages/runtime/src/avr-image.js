/** AVR ELF32 to flash bytes using physical load addresses, excluding EEPROM and SRAM.
 * @param {Uint8Array} elf @param {number} [capacity]
 */
export const elfToAvrBin = (elf, capacity = 30720) => {
  if (elf.length < 52) throw new Error('Truncated AVR ELF');
  const v = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  if (v.getUint32(0, true) !== 0x464c457f || elf[4] !== 1 || elf[5] !== 1 || v.getUint16(18, true) !== 83) throw new Error('Expected AVR ELF32 firmware');
  const start = v.getUint32(28, true), size = v.getUint16(42, true), count = v.getUint16(44, true);
  if (!count || size < 32 || start + size * count > elf.length) throw new Error('Invalid AVR load table');
  /** @type {{address:number,data:Uint8Array}[]} */
  const loads = [];
  for (let i = 0; i < count; i++) {
    const p = start + i * size;
    if (v.getUint32(p, true) !== 1) continue;
    const offset = v.getUint32(p + 4, true), address = v.getUint32(p + 12, true), length = v.getUint32(p + 16, true);
    if (!length) continue;
    if (address >= 0x800000) throw new Error('AVR segment lacks a flash load address or targets EEPROM');
    if (offset + length > elf.length || address + length > capacity) throw new Error('AVR firmware crosses the application/bootloader boundary');
    if (loads.some((load) => address < load.address + load.data.length && address + length > load.address)) throw new Error('Overlapping AVR flash segments');
    loads.push({ address, data: elf.subarray(offset, offset + length) });
  }
  if (!loads.some((load) => load.address === 0)) throw new Error('AVR reset vector is required');
  const image = new Uint8Array(Math.max(...loads.map((load) => load.address + load.data.length))).fill(255);
  for (const load of loads) image.set(load.data, load.address);
  return image;
};
