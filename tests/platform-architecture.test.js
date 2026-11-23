import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { zipSync } from 'fflate';
import {
  createWicroEngine,
  createDefaultPlatformRegistry,
  WicroPlatformRegistry,
  intelHexFormatHandler,
  uf2FormatHandler,
  flatBinFormatHandler
} from '../packages/core/src/index.js';
import { LlvmWasmToolchain } from '../packages/runtime/src/index.js';
import { BrowserLlvmWasmToolchain } from '../packages/runtime/src/browser-toolchain.js';
import { NodeSdkStorage } from '../packages/registry/src/node-cache.js';
import { SdkLifecycleManager, sha256Bytes } from '../packages/registry/src/sdk.js';
import { CompilerAssetManager } from '../packages/registry/src/compiler-assets.js';

const llvmPath = resolve('toolchain/llvm-wasm/cache/llvm.wasm');

/** @param {Map<string, string|Uint8Array>} store */
const createMemoryHost = (store) => ({
  host: /** @type {'browser'} */ ('browser'),
  async readFile(/** @type {string} */ path, /** @type {{encoding?:'utf8'|'binary'}|undefined} */ options) {
    const value = store.get(path);
    if (value === undefined) throw new Error(`File not found: ${path}`);
    if (options?.encoding === 'utf8' && value instanceof Uint8Array) return new TextDecoder().decode(value);
    if (options?.encoding === 'binary' && typeof value === 'string') return new TextEncoder().encode(value);
    return value;
  },
  async readdir(/** @type {string} */ path) {
    const prefix = `${path.replace(/\/+$/, '')}/`;
    const names = new Set();
    for (const key of store.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const first = rest.split('/')[0];
      if (first) names.add(first);
    }
    if (names.size === 0) throw new Error(`Directory not found: ${path}`);
    return [...names].sort();
  },
  async writeFile(/** @type {string} */ path, /** @type {string|Uint8Array} */ data) {
    store.set(path, data);
  }
});

test('canonical platform registry supports registering custom architecture, platform, framework, format and programmer', () => {
  const registry = new WicroPlatformRegistry();
  registry
    .registerArchitecture({
      id: 'custom-arch',
      name: 'Custom 32-bit MCU',
      triple: 'riscv32-unknown-elf',
      elfMachine: 243,
      buildTargetArgs: () => ['--target=riscv32-unknown-elf']
    })
    .registerFramework({
      id: 'custom-fw',
      name: 'Custom Framework',
      supportedExtensions: ['.c'],
      prepareSources: ({ sourcePaths, sourceFiles }) => ({
        units: sourcePaths.map((p) => ({ path: p, source: sourceFiles[p] ?? '', language: 'c' }))
      }),
      defaultDefines: () => ['CUSTOM_FW=1']
    })
    .registerFirmwareFormat({
      id: 'custom-img',
      extension: '.img',
      description: 'Custom image format',
      convert: (elf) => new Uint8Array([0x57, 0x49, ...elf.subarray(0, 4)]),
      validate: (img) => ({ valid: img[0] === 0x57 && img[1] === 0x49, errors: [] })
    })
    .registerProgrammer({
      id: 'custom-prog',
      name: 'Custom Programmer',
      protocols: ['swd'],
      platforms: ['custom-platform']
    })
    .registerPlatform({
      id: 'custom-platform',
      family: 'custom',
      architectures: ['custom-arch'],
      frameworks: ['custom-fw'],
      defaultFirmwareFormat: 'custom-img',
      programmerId: 'custom-prog',
      matchesBoard: (board) => board.architecture === 'custom-arch',
      resolveCompileConfig: async () => ({ compilerFlags: [], includeDirs: [], defines: ['CUSTOM_FW=1'] }),
      prepareLinkPlan: async ({ compiledObjects }) => ({ objects: compiledObjects, firmwareFormat: 'custom-img' })
    });

  const summary = registry.summary();
  assert.deepEqual(summary.architectures, ['custom-arch']);
  assert.deepEqual(summary.platforms, ['custom-platform']);
  assert.deepEqual(summary.frameworks, ['custom-fw']);
  assert.deepEqual(summary.firmwareFormats, ['custom-img']);
  assert.deepEqual(summary.programmers, ['custom-prog']);
});

test('Node.js and Browser WASI produce byte-for-byte identical STM32F103CB ELF, BIN, HEX and UF2 firmware', async () => {
  const projectRoot = resolve('examples/stm32f103cb/bare-metal-blink');
  const boardJson = await readFile(resolve('registry/stm32f103cb/package.json'), 'utf8');
  const wicroJson = await readFile(join(projectRoot, 'wicro.json'), 'utf8');
  const mainC = await readFile(join(projectRoot, 'main.c'), 'utf8');
  const startupC = await readFile(join(projectRoot, 'startup.c'), 'utf8');
  const linkerLd = await readFile(join(projectRoot, 'stm32f103cb.ld'), 'utf8');

  const baseFiles = () => new Map(/** @type {[string, string|Uint8Array][]} */ ([
    ['registry/stm32f103cb/package.json', boardJson],
    ['project/wicro.json', wicroJson],
    ['project/main.c', mainC],
    ['project/startup.c', startupC],
    ['project/stm32f103cb.ld', linkerLd]
  ]));

  // 1. Node.js WASI build
  const nodeStore = baseFiles();
  const nodeEngine = createWicroEngine({
    host: { ...createMemoryHost(nodeStore), host: 'node' },
    platforms: createDefaultPlatformRegistry(),
    toolchain: new LlvmWasmToolchain({ llvmPath })
  });
  const nodeResult = await nodeEngine.execute({ command: 'build', project: 'project', formats: ['hex', 'uf2'] });
  assert.equal(nodeResult.ok, true, JSON.stringify(nodeResult.diagnostics));

  // 2. Browser WASI (@bjorn3/browser_wasi_shim) build using the exact same shared engine
  const wasmBytes = await readFile(llvmPath);
  const compiledModule = await WebAssembly.compile(wasmBytes);
  const browserStore = baseFiles();
  const browserToolchain = new BrowserLlvmWasmToolchain({ loadModule: async () => compiledModule });
  const browserEngine = createWicroEngine({
    host: createMemoryHost(browserStore),
    platforms: createDefaultPlatformRegistry(),
    toolchain: /** @type {any} */ (browserToolchain)
  });
  const browserResult = await browserEngine.execute({ command: 'build', project: 'project', formats: ['hex', 'uf2'] });
  assert.equal(browserResult.ok, true, JSON.stringify(browserResult.diagnostics));

  const nodeElf = /** @type {Uint8Array} */ (nodeStore.get('project/.wicro/build/firmware.elf'));
  const browserElf = /** @type {Uint8Array} */ (browserStore.get('project/.wicro/build/firmware.elf'));
  const nodeBin = /** @type {Uint8Array} */ (nodeStore.get('project/.wicro/build/firmware.bin'));
  const browserBin = /** @type {Uint8Array} */ (browserStore.get('project/.wicro/build/firmware.bin'));
  const nodeHex = /** @type {Uint8Array} */ (nodeStore.get('project/.wicro/build/firmware.hex'));
  const browserHex = /** @type {Uint8Array} */ (browserStore.get('project/.wicro/build/firmware.hex'));
  const nodeUf2 = /** @type {Uint8Array} */ (nodeStore.get('project/.wicro/build/firmware.uf2'));
  const browserUf2 = /** @type {Uint8Array} */ (browserStore.get('project/.wicro/build/firmware.uf2'));

  assert.ok(nodeElf.length > 52 && browserElf.length > 52);
  assert.equal(Buffer.compare(nodeElf, browserElf), 0, 'Node and Browser ELF outputs must match byte-for-byte');
  assert.equal(Buffer.compare(nodeBin, browserBin), 0, 'Node and Browser BIN outputs must match byte-for-byte');
  assert.equal(Buffer.compare(nodeHex, browserHex), 0, 'Node and Browser HEX outputs must match byte-for-byte');
  assert.equal(Buffer.compare(nodeUf2, browserUf2), 0, 'Node and Browser UF2 outputs must match byte-for-byte');
  assert.equal(flatBinFormatHandler.validate(nodeBin).valid, true);
  assert.equal(intelHexFormatHandler.validate(nodeHex).valid, true);
  assert.equal(uf2FormatHandler.validate(nodeUf2).valid, true);
});

test('SDK & compiler cache: atomic install, concurrent deduplication, corruption recovery, invalidation and offline reuse', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'wicro-cache-lifecycle-'));
  try {
    const storage = new NodeSdkStorage({ root: tempRoot });
    const payloadV1 = zipSync({ 'include/demo.h': new TextEncoder().encode('#define DEMO_V 1\n') });
    const shaV1 = await sha256Bytes(payloadV1);
    const payloadV2 = zipSync({ 'include/demo.h': new TextEncoder().encode('#define DEMO_V 2\n') });
    const shaV2 = await sha256Bytes(payloadV2);

    let fetchCount = 0;
    let failNext = true;
    /** @type {typeof fetch} */
    const mockFetch = async (url) => {
      fetchCount++;
      if (String(url).includes('bad-mirror')) throw new Error('Simulated network interruption');
      if (failNext) {
        failNext = false;
        return new Response(new Uint8Array([0x00, 0x01, 0x02]), { status: 200 }); // Corrupted truncated download
      }
      const body = String(url).includes('v2') ? payloadV2 : payloadV1;
      return new Response(body, { status: 200 });
    };

    const manager = new SdkLifecycleManager({ storage, fetch: mockFetch });
    const manifestV1 = {
      name: 'demo-sdk',
      version: '1.0.0',
      kind: /** @type {'platform'} */ ('platform'),
      description: 'Demo SDK',
      license: 'MIT',
      metadata: {
        distribution: {
          url: 'https://bad-mirror.invalid/demo-v1.zip',
          mirrors: ['https://good-mirror.invalid/demo-v1.zip'],
          archiveType: 'zip',
          sha256: shaV1
        }
      }
    };

    // 1. Interrupted/corrupted download fails cleanly with no leftover staging dir
    await assert.rejects(() => manager.ensure(manifestV1), /SHA-256 mismatch/);
    const afterFailEntries = await readdir(tempRoot).catch(() => []);
    assert.equal(afterFailEntries.some((name) => name.includes('.staging-')), false, 'staging directory must be cleaned up on failure');

    // 2. Concurrent installation deduplicates network download and commits atomically
    fetchCount = 0;
    const [r1, r2] = await Promise.all([manager.ensure(manifestV1), manager.ensure(manifestV1)]);
    assert.equal(r1.cache, 'downloaded');
    assert.equal(r2.cache, 'downloaded');
    assert.equal(r1.sha256, shaV1);
    assert.equal(fetchCount, 4, '3 retries on bad mirror + 1 successful fetch on good mirror, shared across concurrent callers');

    // 3. Offline rebuild succeeds with zero network access
    const offlineManager = new SdkLifecycleManager({
      storage,
      fetch: async () => { throw new Error('Network disabled in offline mode'); }
    });
    const cached = await offlineManager.ensure(manifestV1, { offline: true });
    assert.equal(cached.cache, 'cache-hit');

    // 4. Cache invalidation when manifest SHA-256 changes
    const manifestUpdatedSha = {
      ...manifestV1,
      metadata: {
        distribution: {
          url: 'https://good-mirror.invalid/demo-v2.zip',
          archiveType: 'zip',
          sha256: shaV2
        }
      }
    };
    const updated = await manager.ensure(manifestUpdatedSha);
    assert.equal(updated.cache, 'downloaded');
    assert.equal(updated.sha256, shaV2);
    assert.equal(await storage.readText('demo-sdk-1.0.0/include/demo.h'), '#define DEMO_V 2\n');

    // 5. CompilerAssetManager offline mode fails closed on missing compiler, succeeds on cached compiler
    const wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const wasmSha = await sha256Bytes(wasmBytes);
    const compilerManifest = {
      name: 'demo-llvm',
      version: '1.0.0',
      artifacts: {
        clang: {
          url: 'https://good-mirror.invalid/llvm.wasm',
          uncompressedSha256: wasmSha,
          filename: 'llvm.wasm'
        }
      }
    };
    const compilerManager = new CompilerAssetManager({
      storage,
      fetch: async () => new Response(wasmBytes, { status: 200 })
    });
    await assert.rejects(() => compilerManager.ensure(compilerManifest, { offline: true }), /offline mode/);
    const installedCompiler = await compilerManager.ensure(compilerManifest);
    assert.equal(installedCompiler.cache, 'downloaded');
    const offlineCompiler = new CompilerAssetManager({
      storage,
      fetch: async () => { throw new Error('Network disabled'); }
    });
    const hitCompiler = await offlineCompiler.ensure(compilerManifest, { offline: true });
    assert.equal(hitCompiler.cache, 'cache-hit');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
