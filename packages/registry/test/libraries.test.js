import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync, zipSync } from 'fflate';
import { LibraryManager, inspectLibrary, assertNoPlatformIoHooks } from '../src/libraries.js';
import { LibraryCatalog } from '../src/library-catalog.js';
import { extractLibraryArchive } from '../src/library-archive.js';
import { NodeSdkStorage } from '../src/node-cache.js';
import { sha256Bytes } from '../src/sdk.js';

const encode = new TextEncoder();
/** Make a genuine ustar archive for HTTP/package format tests. @param {Record<string,string>} files */
const tarGzip = (files) => {
  const chunks = [];
  for (const [name, value] of Object.entries(files)) {
    const bytes = encode.encode(value);
    const block = new Uint8Array(512 + Math.ceil(bytes.length / 512) * 512);
    block.set(encode.encode(name));
    block.set(encode.encode(bytes.length.toString(8).padStart(11, '0') + '\0'), 124);
    block[156] = 48;
    block.fill(32, 148, 156);
    const checksum = block.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
    block.set(encode.encode(checksum.toString(8).padStart(6, '0') + '\0 '), 148);
    block.set(bytes, 512);
    chunks.push(block);
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 1024));
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return gzipSync(bytes);
};

test('ZIP and TAR.GZ library extraction rejects traversal, truncation and declared hook requirements', () => {
  const files = { 'library.properties': 'name=Counter\nversion=1.0.0', 'src/Counter.c': 'int counter(void) { return 23; }' };
  assert.ok(extractLibraryArchive(tarGzip(files), 'tar.gz')['src/Counter.c']);
  assert.throws(() => extractLibraryArchive(zipSync({ '../library.properties': encode.encode('name=Unsafe') }), 'zip'), /Unsafe/);
  assert.throws(() => extractLibraryArchive(tarGzip({ '/library.properties': 'name=Unsafe' }), 'tar.gz'), /Unsafe/);
  assert.throws(() => extractLibraryArchive(tarGzip(files).slice(0, 30), 'tar.gz'));
  assert.throws(() => inspectLibrary({ 'library.json': encode.encode('{"name":"Generator","build":{"extraScript":"pre:generate.py"}}') }), /Python\/SCons/);
  assert.throws(() => assertNoPlatformIoHooks({ 'platformio.ini': '[env:board]\nextra_scripts =\n  pre:generate.py\n' }, {}), /pre\/post hooks/);
  assert.throws(() => inspectLibrary({ 'library.json': encode.encode('{"build":{"srcFilter":"+<custom>"}}') }), /explicit Wicro recipe/);
  assert.deepEqual(inspectLibrary({ 'library.json': encode.encode('{"build":{"srcDir":"./src"}}'), 'src/Counter.c': encode.encode('int counter(void) { return 23; }') }).sourceFiles, ['src/Counter.c']);
});

test('real HTTP catalogs and archives resolve dependencies, lock versions and survive offline/corrupt cache checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wicro-library-manager-'));
  const dependency = zipSync({ 'Counter/library.properties': encode.encode('name=Counter\nversion=1.0.0\narchitectures=*'), 'Counter/src/Counter.h': encode.encode('int counter(void);'), 'Counter/src/Counter.c': encode.encode('int counter(void) { return 23; }') });
  const dependencyV2 = zipSync({ 'library.properties': encode.encode('name=Counter\nversion=2.0.0'), 'src/Counter.c': encode.encode('int counter(void) { return 99; }') });
  const consumer = zipSync({ 'library.properties': encode.encode('name=Consumer\nversion=1.0.0\ndepends=Counter (^1.0.0)'), 'Consumer.h': encode.encode('#include <Counter.h>') });
  const tar = tarGzip({ 'library.properties': 'name=Publisher\nversion=2.8\narchitectures=*', 'src/Publisher.h': '#pragma once' });
  let downloads = 0;
  let origin = '';
  const server = createServer((request, response) => {
    downloads++;
    if (request.url === '/index.json') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ libraries: [
        { name: 'Consumer', version: '1.0.0', url: `${origin}/consumer.zip`, checksum: `SHA-256:${consumerSha}` },
        { name: 'Counter', version: '1.0.0', url: `${origin}/counter.zip`, checksum: `SHA-256:${dependencySha}` },
        { name: 'Counter', version: '2.0.0', url: `${origin}/counter2.zip`, checksum: `SHA-256:${dependencyV2Sha}` }
      ] }));
    } else if (request.url?.includes('/packages/')) response.end(JSON.stringify({ name: 'Publisher', owner: { username: 'vendor' }, version: { name: '2.8', files: [{ system: '*', download_url: `${origin}/publisher.tar.gz`, checksum: { sha256: tarSha } }] } }));
    else if (request.url === '/consumer.zip') response.end(consumer);
    else if (request.url === '/counter2.zip') response.end(dependencyV2);
    else if (request.url === '/counter.zip') response.end(dependency);
    else if (request.url === '/publisher.tar.gz') response.end(tar);
    else { response.statusCode = 404; response.end(); }
  });
  const consumerSha = await sha256Bytes(consumer);
  const dependencySha = await sha256Bytes(dependency);
  const dependencyV2Sha = await sha256Bytes(dependencyV2);
  const tarSha = await sha256Bytes(tar);
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
    const storage = new NodeSdkStorage({ root });
    const catalog = new LibraryCatalog({ storage, arduinoIndexUrl: `${origin}/index.json`, platformioBaseUrl: origin });
    const manager = new LibraryManager({ storage, catalog });
    /** @type {import('../src/library-catalog.js').LibraryRequest[]} */
    const requests = [{ provider: 'arduino', name: 'Consumer', version: '1.0.0' }, { provider: 'platformio', owner: 'vendor', name: 'Publisher', version: '2.8' }];
    const installed = await manager.ensureProject(requests);
    assert.equal(installed.lock.libraries.length, 3);
    assert.equal(installed.installed.find((entry) => entry.release.name === 'Publisher')?.release.version, '2.8');
    const beforeOffline = downloads;
    const offline = new LibraryManager({ storage, offline: true });
    assert.equal((await offline.ensureProject(requests, installed.lock)).installed.length, 3);
    assert.equal(downloads, beforeOffline);
    const lockedOnly = new LibraryManager({ storage, offline: true, catalog: new LibraryCatalog({ storage, offline: true, arduinoIndexUrl: 'https://unavailable.invalid/catalog.json' }) });
    const reordered = requests.slice().reverse().map(({ name, version, ...rest }) => ({ version, name, ...rest }));
    assert.equal((await lockedOnly.ensureProject(reordered, installed.lock)).installed.length, 3, 'formatting and root order must preserve the existing lock without catalog resolution');
    await storage.writeText(`libraries/${dependencySha}/src/Counter.h`, 'corrupt');
    await assert.rejects(() => offline.ensureProject(requests, installed.lock), /corruption/);
    const recovered = await manager.ensureProject(requests, installed.lock);
    assert.equal(new TextDecoder().decode(recovered.installed.find((entry) => entry.release.name === 'Counter')?.files['src/Counter.h']), 'int counter(void);');
    await assert.rejects(() => manager.ensureProject([{ provider: 'arduino', name: 'Counter', version: '<1.0.0' }]), /not found/);
    await assert.rejects(() => manager.ensureProject([{ provider: 'arduino', name: 'Consumer', version: '1.0.0' }, { provider: 'arduino', name: 'Counter', version: '2.0.0' }]), /Conflicting library versions/);
    const corrupted = { ...installed.lock.libraries[0], sha256: '0'.repeat(64) };
    await assert.rejects(() => manager.load(corrupted), /SHA-256 mismatch/);
    assert.ok(!(await storage.readdir('libraries')).some((name) => name.includes('.staging')));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
