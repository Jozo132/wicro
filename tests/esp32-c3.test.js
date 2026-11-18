import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const examples = [
  'blink',
  'brightness',
  'configurable-blink',
  'pwm',
  'serial-hello',
  'serial-commands',
  'nonblocking-timer',
  'external-library',
  'wifi-scan'
];

for (const name of examples) {
  test(`ESP32-C3 ${name} example is present`, async () => {
    await access(`examples/esp32-c3-supermini/${name}/CMakeLists.txt`);
    await access(`examples/esp32-c3-supermini/${name}/main/main.c`);
  });
}

test('verified blink ELF is ELF32 RISC-V', async () => {
  let elf;
  try {
    elf = await readFile('examples/esp32-c3-supermini/blink/build/wicro_blink.elf');
  } catch {
    return;
  }

  assert.equal(elf[0], 0x7f);
  assert.equal(elf[1], 0x45);
  assert.equal(elf[2], 0x4c);
  assert.equal(elf[3], 0x46);
  assert.equal(elf[4], 1);
  assert.equal(elf.readUInt16LE(18), 243);
});

test('board metadata defines GPIO8, BOOT and native USB pins', async () => {
  const manifest = JSON.parse(await readFile('registry/esp32-c3-supermini/package.json', 'utf8'));

  assert.equal(manifest.metadata.mcu, 'ESP32-C3');
  assert.equal(manifest.metadata.led.pin, 8);
  assert.equal(manifest.metadata.led.activeLow, true);
  assert.equal(manifest.metadata.bootPin, 9);
  assert.deepEqual(manifest.metadata.nativeUsbPins, [18, 19]);
});
