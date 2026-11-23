import assert from 'node:assert/strict';
import test from 'node:test';
import { createWicroEngine, ESP32_C3_ARDUINO_RECIPE, prepareEsp32C3LinkerScripts } from '../src/index.js';

const files = new Map([
  ['registry/esp8266/package.json', JSON.stringify({
    name: 'esp8266', version: '1.0.0', kind: 'board', description: 'ESP8266', license: 'MIT',
    metadata: { build: { kind: 'object', target: 'xtensa', targetOptions: { mcpu: 'esp8266' }, source: 'blink.ino', output: '.wicro/build' } }
  })],
  ['project/blink.ino', 'void setup() { pinMode(LED_BUILTIN, OUTPUT); }\nvoid loop() { delay(500); }\n']
]);

const host = {
  host: /** @type {const} */ ('node'),
  async readFile(/** @type {string} */ path) {
    const value = files.get(path);
    if (value === undefined) throw new Error(`File not found: ${path}`);
    return value;
  },
  async writeFile(/** @type {string} */ path, /** @type {string|Uint8Array} */ data) {
    files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data));
  }
};

const toolchain = {
  async compileSource(/** @type {string} */ source, /** @type {string} */ target, /** @type {{mcpu?:string,mcu?:string,march?:string,mabi?:string}} */ targetOptions, /** @type {{language?:string,cacheDirectory?:string}} */ options) {
    assert.match(source, /#include <Arduino\.h>/);
    assert.match(source, /void setup\(\);/);
    assert.match(source, /void loop\(\);/);
    assert.equal(target, 'xtensa');
    assert.equal(targetOptions.mcpu, 'esp8266');
    assert.equal(options.language, 'c++');
    return { object: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), target, cache: 'miss', diagnostics: [] };
  },
  async targets() { return ['xtensa']; }
};

test('core engine preprocesses .ino as C++ and writes generated source', async () => {
  const engine = createWicroEngine({ host, toolchain: /** @type {any} */ (toolchain) });
  const result = await engine.execute({ command: 'build', project: 'project', board: 'esp8266' });

  assert.equal(result.ok, true);
  const value = /** @type {{generatedCpp?:string}} */ (result.value);
  assert.equal(value.generatedCpp, 'project/.wicro/build/sketch.cpp');
  assert.ok(files.has('project/.wicro/build/sketch.cpp'));
  assert.ok(files.has('project/.wicro/build/blink.o'));
});

test('core engine compiles every C and C++ project source', async () => {
  const multiFiles = new Map([
    ['registry/multi/package.json', JSON.stringify({
      name: 'multi', version: '1.0.0', kind: 'board', description: 'Multi-source board', license: 'MIT',
      metadata: { build: { kind: 'object', target: 'riscv32', targetOptions: { march: 'rv32imc', mabi: 'ilp32' }, output: '.wicro/build' } }
    })],
    ['multi/wicro.json', JSON.stringify({ board: 'multi', build: { sourceDir: 'src' } })],
    ['multi/src/main.cpp', 'int helper(void);\nint main(void) { return helper(); }\n'],
    ['multi/src/helper.c', 'int helper(void) { return 7; }\n']
  ]);
  /** @type {{source:string,target:string,targetOptions:{march?:string,mabi?:string},language?:string}[]} */
  const compiled = [];
  const multiHost = {
    host: /** @type {const} */ ('node'),
    async readFile(/** @type {string} */ path) {
      const value = multiFiles.get(path);
      if (value === undefined) throw new Error(`File not found: ${path}`);
      return value;
    },
    async readdir(/** @type {string} */ path) {
      if (path === 'multi/src') return ['main.cpp', 'helper.c'];
      throw new Error(`Directory not found: ${path}`);
    },
    async writeFile(/** @type {string} */ path, /** @type {string|Uint8Array} */ data) {
      multiFiles.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data));
    }
  };
  const multiToolchain = {
    async compileSource(/** @type {string} */ source, /** @type {string} */ target, /** @type {{march?:string,mabi?:string}} */ targetOptions, /** @type {{language?:string}} */ options) {
      compiled.push({ source, target, targetOptions, language: options.language });
      return { object: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), target, cache: 'miss', diagnostics: [] };
    },
    async targets() { return ['riscv32']; }
  };

  const engine = createWicroEngine({ host: multiHost, toolchain: /** @type {any} */ (multiToolchain) });
  const result = await engine.execute({ command: 'build', project: 'multi' });
  assert.equal(result.ok, true);
  assert.deepEqual(compiled.map((item) => item.language), ['c', 'c++']);
  assert.ok(multiFiles.has('multi/.wicro/build/main.o'));
  assert.ok(multiFiles.has('multi/.wicro/build/helper.o'));

  const commands = JSON.parse(/** @type {string} */ (multiFiles.get('multi/.wicro/build/compile_commands.json')));
  assert.equal(commands.length, 2);
  assert.ok(commands.every((/** @type {{file:string}} */ entry) => typeof entry.file === 'string'));
});

test('firmware build fails closed when staged Arduino ESP32 archives are missing', async () => {
  const files = new Map([
    ['registry/firmware-board/package.json', JSON.stringify({
      name: 'firmware-board', version: '1.0.0', kind: 'board', description: 'Firmware board', license: 'MIT',
      metadata: { build: { kind: 'firmware', target: 'riscv32', targetOptions: { march: 'rv32imc', mabi: 'ilp32' }, output: '.wicro/build' } }
    })],
    ['project/wicro.json', JSON.stringify({ board: 'firmware-board', build: { sourceDir: 'src' } })],
    ['project/src/main.ino', 'void setup() {}\nvoid loop() {}\n']
  ]);
  const host = {
    host: /** @type {const} */ ('node'),
    sdkCacheDirectory: '/missing/sdk',
    async readFile(/** @type {string} */ path) {
      const value = files.get(path);
      if (value === undefined) throw new Error(`File not found: ${path}`);
      return value;
    },
    async readdir(/** @type {string} */ path) {
      if (path === 'project/src') return ['main.ino'];
      if (path === '/missing/sdk') return [];
      throw new Error(`Directory not found: ${path}`);
    },
    async writeFile(/** @type {string} */ path, /** @type {string|Uint8Array} */ data) {
      files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data));
    }
  };
  const toolchain = {
    async compileSource() { return { object: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), target: 'riscv32', cache: 'miss', diagnostics: [] }; },
    async linkEsp32Elf() { return { elf: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), bin: new Uint8Array([1]), target: 'riscv32', diagnostics: [] }; },
    async targets() { return ['riscv32']; }
  };
  const engine = createWicroEngine({ host, toolchain: /** @type {any} */ (toolchain) });
  const result = await engine.execute({ command: 'build', project: 'project', board: 'firmware-board' });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics?.some((/** @type {{message:string}} */ diagnostic) => /libFrameworkArduino\.a|staged target SDK/i.test(diagnostic.message)));
});

test('ESP32 firmware build passes Clang C++ compatibility flags', async () => {
  /** @type {Map<string, string|Uint8Array>} */
  const files = new Map();
  files.set('registry/firmware-board/package.json', JSON.stringify({
    name: 'firmware-board', version: '1.0.0', kind: 'board', description: 'Firmware board', license: 'MIT',
    metadata: { build: { kind: 'firmware', target: 'riscv32', targetOptions: { march: 'rv32imc', mabi: 'ilp32' }, output: '.wicro/build' } }
  }));
  files.set('project/wicro.json', JSON.stringify({ board: 'firmware-board', build: { sourceDir: 'src' } }));
  files.set('project/src/main.ino', 'void setup() {}\nvoid loop() {}\n');
  files.set('/sdk/lib/libFrameworkArduino.a', new Uint8Array([1]));
  files.set('/sdk/memory.ld', 'MEMORY {}');
  files.set('/sdk/sections.ld', 'SECTIONS {}');
  files.set('/sdk/include/Arduino.h', '#pragma once');
  /** @type {Record<string, unknown>|undefined} */
  let compileOptions;
  const host = {
    host: /** @type {const} */ ('node'),
    sdkCacheDirectory: '/sdk',
    async readFile(/** @type {string} */ path, /** @type {{encoding?:'utf8'|'binary'}|undefined} */ options) {
      const value = files.get(path);
      if (value === undefined) throw new Error(`File not found: ${path}`);
      if (options?.encoding === 'binary' && typeof value === 'string') return new TextEncoder().encode(value);
      return value;
    },
    async readdir(/** @type {string} */ path) {
      if (path === 'project/src') return ['main.ino'];
      if (path === '/sdk') return ['lib', 'include', 'memory.ld', 'sections.ld'];
      if (path === '/sdk/lib') return ['libFrameworkArduino.a'];
      if (path === '/sdk/include') return ['Arduino.h'];
      throw new Error(`Directory not found: ${path}`);
    },
    async writeFile(/** @type {string} */ path, /** @type {string|Uint8Array} */ data) {
      files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data));
    }
  };
  const toolchain = {
    async compileSource(/** @type {string} */ _source, /** @type {string} */ _target, /** @type {Record<string, unknown>|undefined} */ _targetOptions, /** @type {Record<string, unknown>} */ options) {
      compileOptions = options;
      return { object: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), target: 'riscv32', cache: 'miss', diagnostics: [] };
    },
    async linkEsp32Elf() { return { elf: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), bin: new Uint8Array([1]), target: 'riscv32', diagnostics: [] }; },
    async targets() { return ['riscv32']; }
  };
  const engine = createWicroEngine({ host, toolchain: /** @type {any} */ (toolchain) });
  const result = await engine.execute({ command: 'build', project: 'project', board: 'firmware-board' });
  assert.equal(result.ok, true);
  assert.ok(compileOptions);
  assert.deepEqual(compileOptions.compilerFlags, [...ESP32_C3_ARDUINO_RECIPE.compilerFlags]);
  const commands = JSON.parse(/** @type {string} */ (files.get('project/.wicro/build/compile_commands.json')));
  assert.ok(commands[0].arguments.includes('-Wno-invalid-constexpr'));
});

test('prepareEsp32C3LinkerScripts preserves assertions while adapting for LLD', () => {
  const mem = 'MEMORY { drom0_0_seg (R) : org = 0x3C000020, len = 0x7FFFE0 }\n  ASSERT(_flash_rodata_dummy_start == ORIGIN(default_rodata_seg), "msg")\n';
  const sec = 'SECTIONS {\n  .iram0.text : { *(.text) }\n  /**\n   * This section is required to skip .iram0.text\n   */\n  .dram0.dummy (NOLOAD) : {}\n  .eh_frame : { KEEP (*(.eh_frame)) }\n  .iram0.text_end (NOLOAD) : {}\n  /* Marks the end of data, bss */\n  .dram0.heap_start (NOLOAD) : {}\n}\n';
  const prepared = prepareEsp32C3LinkerScripts(mem, sec);
  assert.equal(prepared.memoryLd.includes('ASSERT(_flash_rodata_dummy_start'), false);
  assert.ok(prepared.sectionsLd.includes('ASSERT(_flash_rodata_dummy_start == ORIGIN(default_rodata_seg)'));
  assert.ok(prepared.sectionsLd.includes('/DISCARD/ : { *(.eh_frame) *(.eh_frame_hdr) }'));
  assert.ok(prepared.sectionsLd.indexOf('.iram0.text_end') < prepared.sectionsLd.indexOf('.dram0.dummy'));
});
