import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { MemoryFilesystem } from '../../filesystem/src/index.js';
import { PackageInstaller, safeArchivePath, verifySha256 } from '../src/installer.js';

test('installs a ZIP package into a virtual filesystem', async () => {
  const filesystem = new MemoryFilesystem();
  const installer = new PackageInstaller({ files: filesystem });
  const archive = zipSync({
    'manifest.json': strToU8('{"name":"demo","version":"1.0.0"}')
  });

  const result = await installer.installZip(archive, { name: 'demo' });
  assert.equal(result.count, 1);
  const manifest = await filesystem.readFile('/demo/manifest.json');
  assert.equal(new TextDecoder().decode(/** @type {Uint8Array} */ (manifest)), '{"name":"demo","version":"1.0.0"}');
});

test('rejects archive traversal and SHA mismatches', async () => {
  assert.throws(() => safeArchivePath('../secret'), /Unsafe archive path/);
  assert.throws(() => verifySha256(new Uint8Array([1, 2, 3]), '0'.repeat(64)), /SHA-256 mismatch/);
});

test('installs a local package directory', async () => {
  const source = await mkdtemp(join(tmpdir(), 'wicro-package-'));
  const cache = await mkdtemp(join(tmpdir(), 'wicro-cache-'));

  try {
    await mkdir(join(source, 'include'), { recursive: true });
    await writeFile(join(source, 'include', 'demo.h'), '#pragma once\n');

    const result = await new PackageInstaller().installLocal(source, {
      name: 'demo',
      cacheDirectory: cache
    });

    assert.equal(result.kind, 'directory');
    assert.ok(result.target.endsWith('/demo'));
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  }
});
