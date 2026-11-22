import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { createManifestValidator, PackageRegistry, PlatformIoRegistry } from '../src/index.js';
import { SdkLifecycleManager, sha256Bytes } from '../src/sdk.js';
import { NodeSdkStorage } from '../src/node-cache.js';
import { CompilerAssetManager } from '../src/compiler-assets.js';
import { writeFile, rm as remove } from 'node:fs/promises';

/** @type {import('../src/index.js').WicroPackageManifest} */
const validManifest = {
  name: 'stm32/generic',
  version: '1.2.0',
  kind: 'platform',
  description: 'Generic STM32 platform',
  license: 'Apache-2.0',
  dependencies: {
    arm_gcc: '^13.2.0'
  }
};

test('validates a universal package manifest', async () => {
  const validate = await createManifestValidator();
  assert.equal(validate(validManifest).ok, true);

  assert.equal(validate({ name: 'bad', version: 'nope' }).ok, false);
});

test('resolves the highest matching semantic version', async () => {
  const registry = new PackageRegistry();
  await registry.add(validManifest);
  await registry.add({ ...validManifest, version: '1.3.0' });
  await registry.add({ ...validManifest, version: '2.0.0' });

  assert.equal(registry.resolve('stm32/generic', '^1.0.0')?.version, '1.3.0');
  assert.equal(registry.resolve('stm32/generic', '>=2.0.0 <3.0.0')?.version, '2.0.0');
});

test('rejects duplicate package versions', async () => {
  const registry = new PackageRegistry();
  await registry.add(validManifest);

  await assert.rejects(() => registry.add(validManifest), /already exists/);
});

test('PlatformIO adapter normalizes registry search and package lookup', async () => {
  const responses = new Map([
    ['search', { ok: true, status: 200, json: async () => ({ items: [{ name: 'Demo', ownername: 'acme', type: 'library', version: '1.0.0' }] }) }],
    ['package', { ok: true, status: 200, json: async () => ({ name: 'Demo', version: '1.0.0', url: 'https://example.invalid/demo.zip' }) }]
  ]);
  const registry = new PlatformIoRegistry({
    fetch: async (/** @type {string|URL|Request} */ input) => {
      const url = String(input);
      return /** @type {any} */ (url.includes('/search') ? responses.get('search') : responses.get('package'));
    }
  });

  const search = await registry.search('demo');
  assert.equal(search[0].name, 'Demo');
  assert.equal(search[0].owner, 'acme');
  const packageInfo = await registry.get('acme', 'library', 'Demo');
  assert.equal(packageInfo.version, '1.0.0');
});

test('SDK lifecycle downloads once, persists locks and rejects corruption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wicro-sdk-cache-'));
  try {
    const storage = new NodeSdkStorage({ root });
    let downloads = 0;
    const archive = zipSync({ 'Vendor/Core/Arduino.h': new TextEncoder().encode('#pragma once\n') });
    const archiveSha256 = await sha256Bytes(archive);
    /** @type {import('../src/index.js').WicroPackageManifest} */
    const manifest = {
      name: 'vendor-core', version: '1.0.0', kind: 'framework', description: 'Vendor SDK', license: 'MIT',
      metadata: { distribution: { url: 'https://example.invalid/vendor.zip', archiveType: 'zip', sha256: archiveSha256 } }
    };

    const manager = new SdkLifecycleManager({
      storage,
      fetch: async () => {
        downloads++;
        return /** @type {any} */ ({
          ok: true,
          status: 200,
          arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength)
        });
      }
    });

    const [first, second] = await Promise.all([manager.ensure(manifest), manager.ensure(manifest)]);
    assert.equal(downloads, 1);
    assert.equal(first.cache, 'downloaded');
    assert.equal(second.cache, 'downloaded');

    const cacheHitManager = new SdkLifecycleManager({
      storage,
      fetch: async () => { throw new Error('network must not be used'); }
    });
    const hit = await cacheHitManager.ensure(manifest);
    assert.equal(hit.cache, 'cache-hit');
    assert.equal(await storage.exists('wicro-sdk-lock.json'), true);

    await storage.writeBytes('vendor-core-1.0.0/Vendor/Core/Arduino.h', new TextEncoder().encode('corrupted'));
    const recovered = new SdkLifecycleManager({
      storage,
      fetch: async () => { throw new Error('corruption should trigger cache removal and fail closed'); }
    });
    await assert.rejects(() => recovered.ensure(manifest), /network|download|corruption/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SDK lifecycle prefers a local registry cache archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wicro-local-sdk-cache-'));
  try {
    const storage = new NodeSdkStorage({ root });
    const archive = zipSync({ 'Local/Core.h': new TextEncoder().encode('#pragma once\n') });
    const archivePath = join(root, 'local-sdk.zip');
    await writeFile(archivePath, archive);
    const archiveSha256 = await sha256Bytes(archive);
    /** @type {import('../src/index.js').WicroPackageManifest} */
    const manifest = {
      name: 'local-sdk', version: '1.0.0', kind: 'framework', description: 'Local SDK', license: 'MIT',
      metadata: { distribution: { url: 'https://example.invalid/local-sdk.zip', sha256: archiveSha256 } }
    };
    let downloads = 0;
    const manager = new SdkLifecycleManager({
      storage,
      fetch: async () => { downloads++; throw new Error('network must not be used'); }
    });
    const result = await manager.ensure(manifest, { localSources: { 'local-sdk': `file://${archivePath}` } });
    assert.equal(result.cache, 'downloaded');
    assert.equal(downloads, 0);
  } finally {
    await remove(root, { recursive: true, force: true });
  }
});

test('registry-cache archives match their manifest checksums', async () => {
  const root = new URL('../../../registry-cache/', import.meta.url);
  const manifests = new URL('../../../registry/', import.meta.url);
  const cases = [
    ['arduino-avr-core-1.0.0.zip', 'arduino-avr-core/package.json'],
    ['arduino-esp32-1.0.0.zip', 'arduino-esp32/package.json'],
    ['arduino-esp8266-1.0.0.zip', 'arduino-esp8266/package.json'],
    ['arduino-pico-1.0.0.zip', 'arduino-pico/package.json'],
    ['arduino-stm32-core-1.0.0.zip', 'arduino-stm32-core/package.json'],
    ['esp-idf-6.1.1.zip', 'esp-idf-6.1.1/package.json'],
    ['pico-sdk-1.0.0.zip', 'pico-sdk/package.json']
  ];

  for (const [fileName, manifestName] of cases) {
    const archive = new Uint8Array(await readFile(new URL(fileName, root)));
    const manifest = JSON.parse(await readFile(new URL(manifestName, manifests), 'utf8'));
    const distribution = manifest.metadata?.distribution;
    assert.equal(await sha256Bytes(archive), distribution.sha256, `${fileName} must match ${manifestName}`);
  }
});

test('compiler assets persist, verify and reuse across cache hits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wicro-compiler-cache-'));
  const clang = new Uint8Array([0, 97, 115, 109, 1, 2, 3, 4]);
  const clangPath = join(root, 'clang.wasm.fixture');
  await writeFile(clangPath, clang);
  const sha = await sha256Bytes(clang);

  try {
    const storage = new NodeSdkStorage({ root: join(root, 'cache') });
    let downloads = 0;
    const manager = new CompilerAssetManager({
      storage,
      fetch: async () => {
        downloads++;
        return /** @type {any} */ ({ ok: true, status: 200, arrayBuffer: async () => clang.buffer.slice(clang.byteOffset, clang.byteOffset + clang.byteLength), headers: new Headers({ 'content-length': String(clang.byteLength) }) });
      }
    });
    const manifest = {
      name: 'llvm-wasm', version: 'fixture-1',
      artifacts: {
        clang: { url: 'https://example.invalid/llvm.wasm', mirrors: [], compression: null, sha256: sha, uncompressedSha256: sha, filename: 'llvm.wasm' }
      }
    };

    const [first, second] = await Promise.all([manager.ensure(manifest), manager.ensure(manifest)]);
    assert.equal(downloads, 1);
    assert.equal(first.cache, 'downloaded');
    assert.equal(second.cache, 'downloaded');

    const hit = await new CompilerAssetManager({ storage, fetch: async () => { throw new Error('network must not be used'); } }).ensure(manifest);
    assert.equal(hit.cache, 'cache-hit');
  } finally {
    await remove(root, { recursive: true, force: true });
  }
});

test('compiler assets reject tampered local files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wicro-compiler-tamper-'));
  const fixture = join(root, 'llvm.wasm');
  await writeFile(fixture, new Uint8Array([1, 2, 3, 4]));

  try {
    const storage = new NodeSdkStorage({ root: join(root, 'cache') });
    const manager = new CompilerAssetManager({ storage });
    await assert.rejects(() => manager.ensure({
      name: 'llvm-wasm', version: 'tamper-1',
      artifacts: { clang: { url: null, mirrors: [], compression: null, sha256: '0'.repeat(64), uncompressedSha256: '0'.repeat(64), filename: 'llvm.wasm' } }
    }, { localSources: { clang: `file://${fixture}` } }), /SHA-256 mismatch|could not be installed/);
  } finally {
    await remove(root, { recursive: true, force: true });
  }
});

test('resolves transitive dependencies once', async () => {
  const registry = new PackageRegistry();
  await registry.add({
    name: 'cmsis/core',
    version: '1.0.0',
    kind: 'framework',
    description: 'CMSIS core',
    license: 'Apache-2.0'
  });
  await registry.add({
    name: 'board/demo',
    version: '1.0.0',
    kind: 'board',
    description: 'Demo board',
    license: 'MIT',
    dependencies: { 'cmsis/core': '^1.0.0' }
  });

  const tree = registry.resolveTree('board/demo');
  assert.deepEqual(tree.map((item) => item.name), ['board/demo', 'cmsis/core']);
});
