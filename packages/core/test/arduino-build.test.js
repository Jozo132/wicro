import assert from 'node:assert/strict';
import test from 'node:test';
import { createWicroEngine } from '../src/index.js';

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
  assert.ok(files.has('project/.wicro/build/main.o'));
});
