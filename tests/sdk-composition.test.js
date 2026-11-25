import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, unzipSync } from 'fflate';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectTarGzip, finishSdkComposition } from '../packages/registry/src/sdk-composition.js';
import { SdkLifecycleManager, sha256Bytes } from '../packages/registry/src/sdk.js';
import { NodeSdkStorage } from '../packages/registry/src/node-cache.js';

/** Real USTAR fixture encoder. @param {Array<{name:string,text?:string,type?:string}>} entries */
const tar = (entries) => {
  const encode = new TextEncoder(), parts = [];
  for (const entry of entries) {
    const data = encode.encode(entry.text ?? ''), header = new Uint8Array(512);
    const field = (/** @type {number} */ at, /** @type {string} */ value) => header.set(encode.encode(value), at);
    field(0, entry.name); field(100, '0000644\0'); field(124, data.length.toString(8).padStart(11, '0') + '\0');
    header.fill(32, 148, 156); header[156] = (entry.type ?? '0').charCodeAt(0); field(257, 'ustar\0');
    field(148, header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ');
    parts.push(header, data, new Uint8Array((512 - data.length % 512) % 512));
  }
  parts.push(new Uint8Array(1024));
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  return gzipSync(bytes);
};

test('SDK TAR filter retains target data, rejects unsafe paths/links and handles GNU names', () => {
  const rules = [{ prefix: 'target/', to: 'sdk/' }];
  const longName = 'target/' + 'a'.repeat(130);
  const bytes = tar([{ name: 'bin/host-compiler', text: 'ignored host data' }, { name: './target/header.h', text: '#define TARGET 1' }, { name: '././@LongLink', type: 'L', text: longName + '\0' }, { name: 'placeholder', text: 'long-name data' }]);
  const selected = selectTarGzip(bytes, rules);
  assert.deepEqual(Object.keys(selected).sort(), ['sdk/' + 'a'.repeat(130), 'sdk/header.h']);
  assert.equal(new TextDecoder().decode(selected['sdk/header.h']), '#define TARGET 1');
  assert.throws(() => selectTarGzip(tar([{ name: 'target/../escape', text: 'bad' }]), rules), /Unsafe/);
  assert.throws(() => selectTarGzip(tar([{ name: 'target/link', type: '2' }]), rules), /regular file/);
  assert.throws(() => selectTarGzip(tar([{ name: 'target/x', text: 'one' }, { name: 'target/x', text: 'two' }]), rules), /Duplicate/);
  assert.throws(() => selectTarGzip(bytes.subarray(0, bytes.length - 8), rules));
});

test('Node SDK lifecycle composes verified HTTP inputs, checks derived identity and reuses offline cache', async () => {
  const input = tar([{ name: 'target/data.h', text: '#define DATA 42' }, { name: 'bin/compiler', text: 'excluded' }]);
  const rules = [{ prefix: 'target/', to: 'include/' }], selected = selectTarGzip(input, rules);
  const expected = await sha256Bytes(finishSdkComposition(selected)); let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end(input); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const root = await mkdtemp(join(tmpdir(), 'wicro-compose-'));
  try {
    const source = { name: 'target data', url: `http://127.0.0.1:${address.port}/input.tar.gz`, sha256: await sha256Bytes(input), rules };
    const manifest = { name: 'composed-sdk', version: '1.0.0', kind: /** @type {'platform'} */ ('platform'), description: 'HTTP composition fixture', license: 'MIT', metadata: { distribution: { url: '', sha256: expected }, composition: { sources: [source] } } };
    const storage = new NodeSdkStorage({ root }), manager = new SdkLifecycleManager({ storage });
    const installed = await manager.ensure(manifest); assert.equal(installed.sha256, expected); assert.equal(requests, 1);
    assert.equal(await storage.readText(installed.target + '/include/data.h'), '#define DATA 42');
    assert.equal((await manager.ensure(manifest, { offline: true })).cache, 'cache-hit'); assert.equal(requests, 1);
    const entries = unzipSync(finishSdkComposition(selectTarGzip(input, rules))); assert.equal(Object.keys(entries).some((name) => name.includes('compiler')), false);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(() => resolve(undefined))); await rm(root, { recursive: true, force: true }); }
});
