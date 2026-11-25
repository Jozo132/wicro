import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elfToBin } from '../src/elf-utils.js';

test('ARM ELF RAM initializers are placed at the PT_LOAD flash address', async () => {
  // ELF32 format fixture: vectors in flash, .data VMA in RAM and LMA in flash.
  const elf = new Uint8Array(512);
  const v = new DataView(elf.buffer);
  v.setUint32(0, 0x464c457f, true); elf[4] = 1; elf[5] = 1;
  v.setUint16(18, 40, true); v.setUint32(28, 52, true); v.setUint32(32, 160, true);
  v.setUint16(42, 32, true); v.setUint16(44, 2, true); v.setUint16(46, 40, true); v.setUint16(48, 3, true);
  for (let i = 0; i < 2; i++) {
    const p = 52 + i * 32;
    v.setUint32(p, 1, true); v.setUint32(p + 4, 400 + i * 4, true);
    v.setUint32(p + 8, i ? 0x20000000 : 0x08000000, true);
    v.setUint32(p + 12, 0x08000000 + i * 4, true); v.setUint32(p + 16, 4, true);
    const s = 160 + i * 40;
    v.setUint32(s + 4, 1, true); v.setUint32(s + 8, 2, true);
    v.setUint32(s + 12, i ? 0x20000000 : 0x08000000, true);
    v.setUint32(s + 16, 400 + i * 4, true); v.setUint32(s + 20, 4, true);
  }
  // NOBITS RAM must not add a huge zero-filled gap to the firmware.
  v.setUint32(240 + 4, 8, true); v.setUint32(240 + 8, 2, true);
  v.setUint32(240 + 12, 0x20000004, true); v.setUint32(240 + 20, 1024, true);
  elf.set([1, 2, 3, 4, 5, 6, 7, 8], 400);
  assert.deepEqual([...await elfToBin(elf)], [1, 2, 3, 4, 5, 6, 7, 8]);
  v.setUint32(84 + 16, 500, true);
  v.setUint32(200 + 16, 510, true);
  await assert.rejects(elfToBin(elf), /Truncated/);
});
