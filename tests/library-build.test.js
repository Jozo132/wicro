import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import test from 'node:test';
import { zipSync } from 'fflate';
import { createWicroEngine } from '../packages/core/src/index.js';
import { LlvmWasmToolchain } from '../packages/runtime/src/index.js';
import { BrowserLlvmWasmToolchain } from '../packages/runtime/src/browser-toolchain.js';
import { NodeSdkStorage } from '../packages/registry/src/node-cache.js';
import { sha256Bytes } from '../packages/registry/src/sdk.js';

const llvmPath = resolve('toolchain/llvm-wasm/cache/llvm.wasm');

test('Node WASM build automatically imports a declared C source library and links its implementation', async (t) => {
  if (!await stat(llvmPath).catch(() => null)) { t.skip('LLVM WASM artifact is not cached'); return; }
  const root = await mkdtemp(join(tmpdir(), 'wicro-library-build-'));
  const archive = zipSync({
    'Counter/library.properties': new TextEncoder().encode('name=Counter\nversion=1.0.0\narchitectures=*'),
    'Counter/src/Counter.h': new TextEncoder().encode('int counter(void);'),
    'Counter/src/Counter.c': new TextEncoder().encode('int counter(void) { return 23; }')
  });
  const server = createServer((_request, response) => response.end(archive));
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/counter.zip`;
    const project = join(root, 'project');
    await mkdir(project);
    for (const name of ['startup.c', 'stm32f103cb.ld']) await writeFile(join(project, name), await readFile(`examples/stm32f103cb/bare-metal-blink/${name}`));
    await writeFile(join(project, 'main.c'), '#include <Counter.h>\nvolatile int result;\nint main(void) { result = counter(); for (;;) {} }');
    await writeFile(join(project, 'wicro.json'), JSON.stringify({ name: 'source-library', board: 'stm32f103cb', framework: 'bare-metal', build: { sources: ['main.c'] }, libraries: [{ provider: 'archive', name: 'Counter', version: '1.0.0', url, sha256: await sha256Bytes(archive) }] }));
    const storage = new NodeSdkStorage({ root: join(root, 'cache') });
    /** @param {string} path */
    const map = (path) => path.startsWith('registry/') ? resolve(path) : path;
    /** @type {import('../packages/core/src/index.js').WicroHostAdapter} */
    const host = {
      host: 'node', libraryStorage: storage,
      readFile: async (path, options) => options?.encoding === 'utf8' ? readFile(map(path), 'utf8') : readFile(map(path)),
      readdir: async (path) => readdir(map(path)),
      writeFile: async (path, data) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, data); }
    };
    const engine = createWicroEngine({ host, toolchain: new LlvmWasmToolchain({ llvmPath }) });
    const result = await engine.execute({ command: 'build', project, board: 'stm32f103cb' });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    const value = /** @type {any} */ (result.value);
    assert.equal(value.libraries[0].name, 'Counter');
    assert.ok(value.objects.some((/** @type {any} */ object) => object.path.endsWith('/Counter.c')));
    const elf = await readFile(value.elf);
    assert.ok(elf.includes(Buffer.from('counter')), 'ELF symbol table must contain the actual library implementation');
    const commands = JSON.parse(await readFile(value.compileCommands, 'utf8'));
    assert.ok(commands.some((/** @type {any} */ entry) => entry.file.endsWith('/Counter.c')));
    host.offline = true;
    const offline = await engine.execute({ command: 'build', project, board: 'stm32f103cb' });
    assert.equal(offline.ok, true, JSON.stringify(offline.diagnostics));
    assert.deepEqual(await readFile(value.elf), elf);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test('browser WASM object cache includes dependency header contents', async (t) => {
  if (!await stat(llvmPath).catch(() => null)) { t.skip('LLVM WASM artifact is not cached'); return; }
  const module = await WebAssembly.compile(Uint8Array.from(await readFile(llvmPath)).buffer);
  const toolchain = new BrowserLlvmWasmToolchain({ loadModule: async () => module });
  const source = '#include "value.h"\nint value(void) { return VALUE; }';
  const first = await toolchain.compileSource(source, 'riscv32', {}, { files: { 'value.h': '#define VALUE 1' } });
  const hit = await toolchain.compileSource(source, 'riscv32', {}, { files: { 'value.h': '#define VALUE 1' } });
  assert.equal(hit.cache, 'hit');
  const changed = await toolchain.compileSource(source, 'riscv32', {}, { files: { 'value.h': '#define VALUE 2' } });
  assert.equal(changed.cache, 'miss');
  assert.notDeepEqual(changed.object, first.object);
});
