import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const sourceReady = await stat('.wicro/stm32-sdk/upstream/toolchain-gccarmnoneeabi-linux_x86_64-1.120301.0.tar.gz').then(() => true, () => false);
test('Chromium composes both pinned STM32 SDKs from genuine upstream archives and reuses OPFS inputs', { skip: sourceReady ? false : 'Requires genuine upstream archives acquired by the SDK packager', timeout: 180000 }, async () => {
  const manifests = await Promise.all(['f1', 'f4'].map(async (family) => JSON.parse(await readFile(`registry/stm32-${family}-arduino-sdk/package.json`, 'utf8'))));
  const sources = manifests[0].metadata.composition.sources;
  const server = createServer(async (request, response) => {
    const index = Number(request.url?.slice(1)), source = sources[index];
    response.setHeader('Access-Control-Allow-Origin', '*');
    if (!source) { response.statusCode = 404; response.end(); return; }
    if (source.format === 'github-blob') {
      const path = source.output.includes('arm_acle') ? 'arm_acle.h' : 'LLVM-LICENSE.TXT';
      const bytes = await readFile('.wicro/stm32-sdk/' + path);
      const body = JSON.stringify({ encoding: 'base64', size: bytes.length, content: bytes.toString('base64') });
      response.setHeader('Content-Length', Buffer.byteLength(body)); response.end(body); return;
    }
    const path = '.wicro/stm32-sdk/upstream/' + new URL(source.url).pathname.split('/').at(-1);
    response.setHeader('Content-Length', (await stat(path)).size); createReadStream(path).pipe(response);
  });
  const port = 8200 + Math.floor(Math.random() * 400), origin = `http://127.0.0.1:${port}`;
  const vite = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve('apps/web'), stdio: 'ignore' });
  /** @type {import('playwright').Browser|undefined} */ let browser;
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(origin)).ok) break; } catch { /* Vite startup. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const page = await browser.newPage(); await page.goto(origin);
    const urls = Object.fromEntries(sources.map((/** @type {{url:string}} */ source, /** @type {number} */ index) => [source.url, `http://127.0.0.1:${address.port}/${index}`]));
    const result = await page.evaluate(async ({ manifests, urls, workerPath }) => new Promise((resolve, reject) => {
      const worker = new Worker(workerPath, { type: 'module' });
      worker.onmessage = (event) => { worker.terminate(); resolve(event.data); };
      worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message)); };
      worker.postMessage({ manifests, urls });
    }), { manifests, urls, workerPath: '/@fs' + resolve('tests/helpers/sdk-compose-worker.js') });
    const value = /** @type {any} */ (result);
    assert.equal(value.ok, true, JSON.stringify(value)); assert.equal(value.downloads, 5);
    assert.equal(value.results.length, 2);
    for (const item of value.results) assert.equal(item.sha256, item.expected, item.name);
  } finally { await browser?.close(); vite.kill('SIGKILL'); server.closeAllConnections(); await new Promise((resolve) => server.close(() => resolve(undefined))); }
});
