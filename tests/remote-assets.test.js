import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { zipSync } from 'fflate';
import { chromium } from 'playwright';
import { SdkLifecycleManager, sha256Bytes } from '../packages/registry/src/sdk.js';
import { NodeSdkStorage } from '../packages/registry/src/node-cache.js';

/** @param {import('node:http').Server} server */
const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  return `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
};

// Real HTTP servers and a real Chromium worker: no intercepted requests or fetch mocks.
test('remote assets: browser CORS, redirects, integrity, mirrors, OPFS reload and Node parity', async () => {
  const archive = zipSync({ 'core/Arduino.h': new TextEncoder().encode('#pragma once\n') });
  const wasm = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
  const sdkSha = await sha256Bytes(archive);
  const wasmSha = await sha256Bytes(wasm);
  const bundle = await build({
    entryPoints: ['tests/fixtures/remote-assets-browser.js'], bundle: true, write: false,
    platform: 'browser', format: 'esm', external: ['node:*']
  });
  /** @type {Map<string,number>} */
  const hits = new Map();
  const remote = createServer((request, response) => {
    const path = request.url ?? '/';
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path !== '/blocked.zip') response.setHeader('Access-Control-Allow-Origin', '*');
    if (path === '/redirect.zip') { response.writeHead(302, { Location: '/sdk.zip' }); response.end(); return; }
    if (path === '/redirect-blocked.zip') { response.writeHead(302, { Location: '/blocked.zip' }); response.end(); return; }
    if (path === '/missing.zip') { response.writeHead(404); response.end(); return; }
    if (path === '/html.zip') { response.setHeader('Content-Type', 'text/html'); response.end('<html>SPA fallback</html>'); return; }
    response.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : 'application/zip');
    response.end(path.endsWith('.wasm') ? wasm : archive);
  });
  const app = createServer((request, response) => {
    if (request.url === '/sdk.zip') { response.end(archive); return; }
    response.setHeader('Content-Type', request.url === '/worker.js' ? 'text/javascript' : 'text/html');
    response.end(request.url === '/worker.js' ? bundle.outputFiles[0].contents : '<!doctype html><title>Remote asset validation</title>');
  });
  const root = await mkdtemp(join(tmpdir(), 'wicro-remote-assets-'));
  /** @type {import('playwright').Browser|undefined} */
  let browser;
  try {
    const remoteOrigin = await listen(remote);
    const appOrigin = await listen(app);
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(appOrigin);
    /** @param {Record<string,any>} request */
    const run = async (request) => page.evaluate((input) => new Promise((resolve) => {
      const worker = new Worker('/worker.js', { type: 'module' });
      worker.onmessage = (event) => { worker.terminate(); resolve(event.data); };
      worker.onerror = (event) => { worker.terminate(); resolve({ error: event.message }); };
      worker.postMessage(input);
    }), request);
    /** @param {string} name @param {string} path @param {string[]} [mirrors] @returns {import('../packages/registry/src/index.js').WicroPackageManifest} */
    const manifest = (name, path, mirrors = []) => ({
      name, version: '1.0.0', kind: 'framework', description: 'HTTP test SDK', license: 'MIT',
      metadata: { distribution: { url: `${remoteOrigin}${path}`, mirrors, sha256: sdkSha } }
    });

    const direct = await run({ kind: 'sdk', manifest: manifest('direct', '/redirect.zip') });
    assert.equal(direct.value?.cache, 'downloaded', direct.error);
    assert.equal(direct.value.content, '#pragma once\n');
    assert.ok(hits.get('/redirect.zip'));
    await page.reload();
    const before = hits.get('/sdk.zip');
    const cached = await run({ kind: 'sdk', manifest: manifest('direct', '/redirect.zip'), offline: true });
    assert.equal(cached.value?.cache, 'cache-hit', cached.error);
    assert.equal(hits.get('/sdk.zip'), before);

    const blocked = await run({ kind: 'download', url: `${remoteOrigin}/blocked.zip` });
    assert.match(blocked.error, /CORS.*Access-Control-Allow-Origin/);
    const redirectBlocked = await run({ kind: 'download', url: `${remoteOrigin}/redirect-blocked.zip` });
    assert.match(redirectBlocked.error, /CORS/);
    const missing = await run({ kind: 'download', url: `${remoteOrigin}/missing.zip` });
    assert.match(missing.error, /HTTP 404/);

    for (const path of ['/blocked.zip', '/html.zip', '/missing.zip']) {
      const result = await run({ kind: 'sdk', manifest: manifest(`mirror-${path.slice(1)}`, path, [`${remoteOrigin}/sdk.zip`]) });
      assert.equal(result.value?.cache, 'downloaded', result.error);
    }
    const relative = manifest('relative', '/sdk.zip');
    relative.metadata = { distribution: { url: '/sdk.zip', sha256: sdkSha } };
    const relativeResult = await run({ kind: 'sdk', manifest: relative });
    assert.equal(relativeResult.value?.cache, 'downloaded', relativeResult.error);

    const corruptManifest = manifest('corrupt', '/html.zip');
    assert.match((await run({ kind: 'sdk', manifest: corruptManifest })).error, /SHA-256 mismatch/);
    assert.match((await run({ kind: 'sdk', manifest: corruptManifest, offline: true })).error, /offline mode/);

    const compiler = { name: 'test-wasm', version: '1.0.0', artifacts: { clang: {
      url: `${remoteOrigin}/html.zip`, mirrors: [`${remoteOrigin}/compiler.wasm`], filename: 'llvm.wasm',
      sha256: wasmSha, uncompressedSha256: wasmSha
    } } };
    const installedCompiler = await run({ kind: 'compiler', manifest: compiler });
    assert.equal(installedCompiler.value?.cache, 'downloaded', installedCompiler.error);
    await page.reload();
    assert.equal((await run({ kind: 'compiler', manifest: compiler, offline: true })).value?.cache, 'cache-hit');

    // Node is allowed to read the same endpoint that the browser correctly blocks.
    const nodeStorage = new NodeSdkStorage({ root });
    const nodeResult = await new SdkLifecycleManager({ storage: nodeStorage }).ensure(manifest('node', '/blocked.zip'));
    assert.equal(nodeResult.cache, 'downloaded');
    assert.equal(await nodeStorage.readText(`${nodeResult.target}/core/Arduino.h`), '#pragma once\n');
    const nodeMirror = await new SdkLifecycleManager({ storage: nodeStorage }).ensure(manifest('node-mirror', '/html.zip', [`${remoteOrigin}/sdk.zip`]));
    assert.equal(nodeMirror.cache, 'downloaded');
  } finally {
    await browser?.close();
    app.closeAllConnections(); remote.closeAllConnections();
    await Promise.all([new Promise((resolve) => app.close(resolve)), new Promise((resolve) => remote.close(resolve))]);
    await rm(root, { recursive: true, force: true });
  }
});
