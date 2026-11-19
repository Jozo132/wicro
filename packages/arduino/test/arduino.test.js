import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  discoverArduinoLibraries,
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

  const platform = parsePropertyFile(`name=Arduino AVR Boards\narchitecture=avr\n`);
  assert.equal(platform.name, 'Arduino AVR Boards');
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
