import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  discoverArduinoLibraries,
  discoverStm32Boards,
  findMissingHeaders,
  parseBoardsTxt,
  parseLibraryJson,
  parseLibraryProperties,
  parsePlatformIoIni,
  parsePropertyFile,
  ArduinoRegistry,
  preprocessIno
} from '../src/index.js';

test('preprocesses multiple .ino tabs with Arduino.h and prototypes', () => {
  const result = preprocessIno({
    'blink.ino': 'void setup() { pinMode(13, OUTPUT); }\nvoid loop() { blink(); }\n',
    'blink-helper.ino': 'void blink() { digitalWrite(13, HIGH); }\n'
  });

  assert.match(result.cpp, /^#include <Arduino\.h>/);
  assert.ok(result.prototypes.includes('void setup();'));
  assert.ok(result.prototypes.includes('void loop();'));
  assert.ok(result.prototypes.includes('void blink();') || result.cpp.includes('void blink()'));
  assert.ok(result.sourceMap.every((entry) => entry.generatedLine > 0));
  assert.equal(result.sourceMap[0].source, 'blink.ino');
});

test('detects setup, loop and custom function declarations', () => {
  const result = preprocessIno({
    'main.ino': 'int add(int left, int right) { return left + right; }\nvoid setup() { pinMode(2, OUTPUT); }\nvoid loop() { add(1, 2); }\n'
  });
  assert.ok(result.prototypes.some((prototype) => prototype.includes('add')));
});

test('parses boards.txt menu options and platform metadata', () => {
  const boards = parseBoardsTxt(`uno.name=Arduino Uno\nuno.build.mcu=atmega328p\nuno.menu.cpu.atmega328=ATmega328P\nuno.menu.cpu.atmega328.build.mcu=atmega328p\nuno.upload.protocol=arduino\n`);
  assert.equal(boards.uno.name, 'Arduino Uno');
  assert.equal(boards.uno.properties['build.mcu'], 'atmega328p');
  assert.equal(boards.uno.properties.upload, undefined);
  assert.equal(boards.uno.properties['upload.protocol'], 'arduino');
  assert.ok(boards.uno.menus.cpu);
  assert.equal(boards.uno.menus.cpu.atmega328, 'ATmega328P');
  assert.equal(boards.uno.menuProperties.cpu.atmega328['build.mcu'], 'atmega328p');

  const platform = parsePropertyFile(`name=Arduino AVR Boards\narchitecture=avr\n`);
  assert.equal(platform.name, 'Arduino AVR Boards');
});

test('dynamically discovers STM32 board-menu devices as selectable targets', () => {
  const boards = parseBoardsTxt(`generic_f401.name=Generic STM32F401RC\ngeneric_f401.build.mcu=STM32F401RC\ngeneric_f401.build.variant=STM32F4xx/F401R(B-C-D-E)T\ngeneric_f401.build.f_cpu=84000000L\ngeneric_f401.upload.maximum_size=262144\ngeneric_f401.build.maximum_ram_size=65536\ngeneric_f401.build.series=STM32F4xx\ngeneric_f411.name=Generic STM32F411CE\ngeneric_f411.build.mcu=STM32F411CE\ngeneric_f411.build.variant=STM32F4xx/F411C(C-E)(U-Y)\ngeneric_f411.build.f_cpu=100000000L\ngeneric_f411.upload.maximum_size=524288\ngeneric_f411.build.maximum_ram_size=131072\ngeneric_f411.build.series=STM32F4xx\ngeneric_f4.name=Generic STM32F4 series\ngeneric_f4.build.mcu=CORTEX-M4\ngeneric_f4.build.series=STM32F4xx\ngeneric_f4.menu.pnum.F401RCTx=Generic F401RCTx\ngeneric_f4.menu.pnum.F401RCTx.build.mcu=STM32F401xC\ngeneric_f4.menu.pnum.F401RCTx.build.product_line=STM32F401xC\ngeneric_f4.menu.pnum.F401RCTx.build.variant=STM32F4xx/F401R(C-D)T\n`);
  const discovered = discoverStm32Boards(boards, { family: 'stm32-f4-arduino-sdk', sourceVersion: '1.0.0' });
  assert.equal(discovered.length, 3);
  assert.ok(discovered.some((board) => board.metadata.mcu === 'STM32F401RC'));
  assert.ok(discovered.some((board) => board.metadata.mcu === 'STM32F411CE'));
  assert.ok(discovered.some((board) => board.name === 'Generic STM32F401RC'));
  assert.ok(discovered.some((board) => board.name === 'Generic STM32F411CE'));
  assert.ok(discovered.every((board) => board.metadata.mcuType === 'STM32'));
  assert.ok(discovered.every((board) => board.metadata.mcuFamily === 'STM32'));
  assert.equal(discovered.find((board) => board.metadata.mcuDevice === 'Generic F401RCTx')?.name, 'Generic STM32F4 series · Generic F401RCTx');
  assert.equal(discovered.find((board) => board.metadata.mcuDevice === 'Generic F401RCTx')?.metadata.mcuSeries, 'Generic STM32F4 series');
  assert.equal(discovered.find((board) => board.metadata.mcuDevice === 'Generic F401RCTx')?.metadata.mcu, 'STM32F401XC');
  assert.equal(discovered.find((board) => board.metadata.mcuDevice === 'Generic F401RCTx')?.metadata.frameworkConfigurations.arduino.metadata.arduino.productLine, 'STM32F401xC');
  assert.equal(discovered.find((board) => board.metadata.mcuDevice === 'Generic F401RCTx')?.metadata.frameworkConfigurations.arduino.metadata.arduino.variant, 'STM32F4xx/F401R(C-D)T');
  assert.equal(discovered.find((board) => board.metadata.mcu === 'STM32F401RC')?.metadata.mcuSeries, 'STM32F4');
  assert.equal(discovered.find((board) => board.metadata.mcu === 'STM32F401RC')?.metadata.mcuDevice, 'STM32F401RC');
  assert.equal(discovered.find((board) => board.metadata.mcu === 'STM32F401RC')?.id, 'stm32-generic-f401');
  assert.ok(discovered.every((board) => board.metadata.boardName));
  assert.ok(discovered.every((board) => board.metadata.boardPreset));
  assert.ok(discovered.every((board) => board.metadata.dynamic === true));
  assert.ok(discovered.every((board) => board.metadata.platform === 'st-stm32-bare-metal'));
  assert.ok(discovered.every((board) => board.metadata.programmerId === 'stm32-cdc-dfu'));
});

test('parses library.properties, library.json and platformio.ini', () => {
  const properties = parseLibraryProperties('name=FastLED\nversion=3.10.3\narchitectures=*\nincludes=FastLED.h\n');
  assert.equal(properties.name, 'FastLED');
  assert.equal(properties.version, '3.10.3');

  const library = parseLibraryJson('{"name":"ArduinoJson","version":"7.4.2","architectures":["*"],"includes":"ArduinoJson.h"}');
  assert.equal(library.name, 'ArduinoJson');
  assert.deepEqual(library.includes, ['ArduinoJson.h']);

  const pio = parsePlatformIoIni('[env:uno]\nplatform = atmelavr\nboard = uno\nframework = arduino\nbuild_flags = -DTEST=1\n');
  assert.equal(pio['env:uno'].board, 'uno');
  assert.equal(pio['env:uno'].build_flags, '-DTEST=1');
});

test('official Arduino SDK and board presets are declared', async () => {
  const sdkNames = ['arduino-avr-core', 'arduino-esp32', 'arduino-esp8266', 'arduino-stm32-core', 'arduino-pico'];
  for (const name of sdkNames) {
    const manifest = JSON.parse(await readFile(new URL(`../../../registry/${name}/package.json`, import.meta.url), 'utf8'));
    assert.equal(manifest.kind, 'framework');
  }

  const boardNames = ['arduino-nano', 'arduino-mega', 'arduino-leonardo', 'esp32-devkit', 'esp32-s2', 'esp32-s3', 'esp32-c6', 'esp32-h2', 'esp8266-nodemcu', 'esp8266-d1-mini', 'stm32-blue-pill', 'stm32-black-pill', 'stm32-nucleo-f401re', 'raspberry-pi-pico-w', 'raspberry-pi-pico-2', 'raspberry-pi-pico-2-w'];
  for (const name of boardNames) {
    const manifest = JSON.parse(await readFile(new URL(`../../../registry/${name}/package.json`, import.meta.url), 'utf8'));
    assert.equal(manifest.kind, 'board');
    assert.equal(manifest.metadata.framework, 'arduino');
  }
});

test('Arduino Library Manager search normalizes results', async () => {
  const registry = new ArduinoRegistry({
    host: 'node',
    fetch: async () => /** @type {any} */ ({
      ok: true,
      status: 200,
      json: async () => ({ libraries: [{ name: 'FastLED', paragraph: 'LED strip control', category: 'Display', version: '3.10.3', architectures: ['*'] }] })
    })
  });
  const results = await registry.searchLibraries('fastled');
  assert.equal(results[0].name, 'FastLED');
  assert.equal(results[0].version, '3.10.3');
});

test('browser Arduino index access reports CORS explicitly', async () => {
  const registry = new ArduinoRegistry({
    host: 'browser',
    fetch: async () => { throw new Error('blocked'); }
  });
  await assert.rejects(() => registry.libraryIndex(), /CORS|browser|cached\/offline/i);
});

test('discovers libraries and reports missing headers', () => {
  const files = {
    'libraries/FastLED/library.properties': 'name=FastLED\nversion=3.10.3\narchitectures=*\n',
    'libraries/FastLED/src/FastLED.h': '#pragma once\n',
    'src/main.ino': '#include <FastLED.h>\n#include <Missing.h>\nvoid setup() {}\nvoid loop() {}\n'
  };
  const libraries = discoverArduinoLibraries(files, ['FastLED.h']);
  assert.equal(libraries[0].name, 'FastLED');
  assert.deepEqual(findMissingHeaders(files, ['FastLED.h', 'Arduino.h']), ['Missing.h']);
});

test('Arduino preprocessing preserves global library constructors instead of generating invalid prototypes', () => {
  const result = preprocessIno({ 'oled.ino': '#include <Adafruit_SSD1306.h>\nAdafruit_SSD1306 display(128, 64, &Wire, -1);\nvoid setup() {}\nvoid loop() {}\n' });
  assert.ok(!result.prototypes.some((prototype) => prototype.includes('display(')));
  assert.equal(result.cpp.match(/Adafruit_SSD1306 display/g)?.length, 1);
});

test('PlatformIO multiline dependency constraints and Python hooks remain visible to importers', () => {
  const sections = parsePlatformIoIni('[env:oled]\nlib_deps =\n  adafruit/Adafruit SSD1306 @ >=2.5.0\n  knolleary/PubSubClient @ ^2.8\nextra_scripts =\n  pre:generate.py\n  post:sign.py\n');
  assert.match(sections['env:oled'].lib_deps, /SSD1306 @ >=2.5.0/);
  assert.match(sections['env:oled'].extra_scripts, /pre:generate.py\npost:sign.py/);
});
