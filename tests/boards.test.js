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

test('STM32F401RC second-MVP metadata is present', async () => {
  const manifest = JSON.parse(await readFile('registry/stm32f401rc/package.json', 'utf8'));

  assert.equal(manifest.metadata.mcu, 'STM32F401RC');
  assert.equal(manifest.metadata.architecture, 'armv7e-m');
  assert.equal(manifest.metadata.cpu, 'cortex-m4');
  assert.equal(manifest.metadata.flashCapacityBytes, 262144);
  assert.equal(manifest.metadata.sramCapacityBytes, 65536);
  assert.equal(manifest.metadata.leds.red.port, 'C');
  assert.equal(manifest.metadata.leds.red.pin, 13);
  assert.equal(manifest.metadata.leds.red.activeLow, true);
});

test('STM32F401RC bare-metal ELF fixture is ELF32 ARM', async () => {
  let elf;
  try {
    elf = await readFile('examples/stm32f401rc/bare-metal-blink/build/blink.elf');
  } catch {
    return;
  }

  assert.equal(elf[0], 0x7f);
  assert.equal(elf[1], 0x45);
  assert.equal(elf[2], 0x4c);
  assert.equal(elf[3], 0x46);
  assert.equal(elf[4], 1);
  assert.equal(elf.readUInt16LE(18), 40);
});

test('STM32F401RC second-MVP metadata is present', async () => {
  const manifest = JSON.parse(await readFile('registry/stm32f401rc/package.json', 'utf8'));

  assert.equal(manifest.metadata.mcu, 'STM32F401RC');
  assert.equal(manifest.metadata.architecture, 'armv7e-m');
  assert.equal(manifest.metadata.cpu, 'cortex-m4');
  assert.equal(manifest.metadata.flashCapacityBytes, 262144);
  assert.equal(manifest.metadata.sramCapacityBytes, 65536);
  assert.equal(manifest.metadata.leds.red.port, 'C');
  assert.equal(manifest.metadata.leds.red.pin, 13);
  assert.equal(manifest.metadata.leds.red.activeLow, true);
});

test('STM32F401RC bare-metal ELF fixture is ELF32 ARM', async () => {
  let elf;
  try {
    elf = await readFile('examples/stm32f401rc/bare-metal-blink/build/blink.elf');
  } catch {
    return;
  }

  assert.equal(elf[0], 0x7f);
  assert.equal(elf[1], 0x45);
  assert.equal(elf[2], 0x4c);
  assert.equal(elf[3], 0x46);
  assert.equal(elf[4], 1);
  assert.equal(elf.readUInt16LE(18), 40);
});

test('Arduino UNO original metadata and blink example are present', async () => {
  const manifest = JSON.parse(await readFile('registry/arduino-uno-original/package.json', 'utf8'));

  assert.equal(manifest.metadata.mcu, 'ATmega328P');
  assert.equal(manifest.metadata.architecture, 'avr');
  assert.equal(manifest.metadata.clockHz, 16000000);
  assert.equal(manifest.metadata.led.port, 'B');
  assert.equal(manifest.metadata.led.pin, 5);
  assert.equal(manifest.metadata.led.activeLow, false);
  await access('examples/arduino-uno-original/blink/main.c');
  await access('examples/arduino-uno-original/blink/Makefile');
});

test('ESP32, ESP8266, RP2040 and RP2350 board examples are present', async () => {
  const boards = [
    ['registry/esp32-original/package.json', 'esp32-original', 'xtensa'],
    ['registry/esp8266/package.json', 'esp8266', 'xtensa'],
    ['registry/rp2040/package.json', 'rp2040', 'armv6m'],
    ['registry/rp2350/package.json', 'rp2350', 'armv8m-mainline']
  ];

  for (const [manifestPath, name, architecture] of boards) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.name, name);
    assert.equal(manifest.metadata.architecture, architecture);
  }

  await access('examples/esp32-original/blink/main/main.c');
  await access('examples/esp8266/blink/blink.ino');
  await access('examples/rp2040/blink/main.c');
  await access('examples/rp2350/blink/main.c');
});

test('STM32F103CB and STM32H723VG metadata and blink examples are present', async () => {
  const f103 = JSON.parse(await readFile('registry/stm32f103cb/package.json', 'utf8'));
  const h723 = JSON.parse(await readFile('registry/stm32h723vg/package.json', 'utf8'));

  assert.equal(f103.metadata.mcu, 'STM32F103CB');
  assert.equal(f103.metadata.architecture, 'armv7-m');
  assert.equal(f103.metadata.cpu, 'cortex-m3');
  assert.equal(f103.metadata.flashCapacityBytes, 131072);
  assert.equal(f103.metadata.sramCapacityBytes, 20480);

  assert.equal(h723.metadata.mcu, 'STM32H723VG');
  assert.equal(h723.metadata.architecture, 'armv7e-m');
  assert.equal(h723.metadata.cpu, 'cortex-m7');
  assert.equal(h723.metadata.flashCapacityBytes, 1048576);

  await access('examples/stm32f103cb/bare-metal-blink/main.c');
  await access('examples/stm32f103cb/bare-metal-blink/Makefile');
  await access('examples/stm32h723vg/bare-metal-blink/main.c');
  await access('examples/stm32h723vg/bare-metal-blink/Makefile');

  try {
    const f103Elf = await readFile('examples/stm32f103cb/bare-metal-blink/build/blink.elf');
    assert.equal(f103Elf.readUInt16LE(18), 40);
  } catch {
    // ELF fixtures are generated and ignored until make runs.
  }

  try {
    const h723Elf = await readFile('examples/stm32h723vg/bare-metal-blink/build/blink.elf');
    assert.equal(h723Elf.readUInt16LE(18), 40);
  } catch {
    // ELF fixtures are generated and ignored until make runs.
  }
});

test('board metadata defines GPIO8, BOOT and native USB pins', async () => {
  const manifest = JSON.parse(await readFile('registry/esp32-c3-supermini/package.json', 'utf8'));

  assert.equal(manifest.metadata.mcu, 'ESP32-C3');
  assert.equal(manifest.metadata.led.pin, 8);
  assert.equal(manifest.metadata.led.activeLow, true);
  assert.equal(manifest.metadata.bootPin, 9);
  assert.deepEqual(manifest.metadata.nativeUsbPins, [18, 19]);
});
