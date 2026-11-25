import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEsp32OriginalSecurity, flashEsp32Original } from '../src/esp32-original.js';

test('ESP32 boot recipe rejects enabled encryption and either secure boot eFuse', () => {
  for (let count = 0; count < 128; count++) {
    const enabled = count.toString(2).replace(/0/g, '').length % 2;
    if (enabled) assert.throws(() => validateEsp32OriginalSecurity(count << 20, 0), /encryption/);
    else assert.doesNotThrow(() => validateEsp32OriginalSecurity(count << 20, 0));
  }
  for (const secureBoot of [0x10, 0x20, 0x30]) assert.throws(() => validateEsp32OriginalSecurity(0, secureBoot), /secure boot/);
});

test('Invalid or oversized ESP32 boot images fail before opening a transport', async () => {
  await assert.rejects(() => flashEsp32Original(null, new Uint8Array(32)), /header/);
  await assert.rejects(() => flashEsp32Original(null, new Uint8Array(0x7010)), /header/);
});
