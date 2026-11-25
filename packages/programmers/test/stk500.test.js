import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNanoFirmware } from '../src/stk500.js';
import { elfToAvrBin } from '../../runtime/src/avr-image.js';

test('Nano images require a valid AVR reset entry and cannot cross the bootloader boundary', () => {
  const image = Uint8Array.of(0x0c, 0x94, 2, 0, 0, 0);
  assert.equal(validateNanoFirmware(image).entry, 4);
  assert.throws(() => validateNanoFirmware(new Uint8Array(30721)), /bootloader/);
  assert.throws(() => validateNanoFirmware(new Uint8Array(8)), /JMP/);
  assert.throws(() => validateNanoFirmware(Uint8Array.of(0x0c, 0x94, 0xff, 0x7f)), /outside/);
});
test('AVR ELF extraction uses flash LMAs for RAM data and rejects EEPROM or protected flash', () => {
  const elf = new Uint8Array(160), v = new DataView(elf.buffer);
  v.setUint32(0, 0x464c457f, true); elf[4] = 1; elf[5] = 1; v.setUint16(18, 83, true);
  v.setUint32(28, 52, true); v.setUint16(42, 32, true); v.setUint16(44, 2, true);
  for (let i = 0; i < 2; i++) { const at = 52 + i * 32; v.setUint32(at, 1, true); v.setUint32(at + 4, 128 + i * 4, true); v.setUint32(at + 8, i ? 0x800100 : 0, true); v.setUint32(at + 12, i * 4, true); v.setUint32(at + 16, 4, true); }
  elf.set([12, 148, 2, 0, 9, 8, 7, 6], 128);
  assert.deepEqual([...elfToAvrBin(elf)], [12, 148, 2, 0, 9, 8, 7, 6]);
  v.setUint32(84 + 12, 0x810000, true); assert.throws(() => elfToAvrBin(elf), /EEPROM/);
  v.setUint32(84 + 12, 30720, true); assert.throws(() => elfToAvrBin(elf), /bootloader/);
});
