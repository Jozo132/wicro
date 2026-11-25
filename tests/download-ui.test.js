import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

test('Chromium worker download panel pauses, resumes and cancels a real compiler transfer without log spam', { timeout: 45000 }, async () => {
  const port = 6500 + Math.floor(Math.random() * 1000), upstream = `http://127.0.0.1:${port}`;
  const vite = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve('apps/web'), stdio: 'ignore' });
  const compiler = await readFile('toolchain/llvm-wasm/cache/llvm.wasm');
  /** @type {(string|undefined)[]} */ const ranges = [];
  let closedTransfers = 0;
  const proxy = createServer((request, response) => {
    if (request.url === '/toolchain/llvm.wasm') {
      ranges.push(request.headers.range);
      const offset = Number(request.headers.range?.match(/bytes=(\d+)-/)?.[1] ?? 0);
      response.writeHead(offset ? 206 : 200, { 'Content-Type': 'application/wasm', 'Content-Length': compiler.length - offset, ETag: '"pinned-compiler"', 'Accept-Ranges': 'bytes', ...(offset ? { 'Content-Range': `bytes ${offset}-${compiler.length - 1}/${compiler.length}` } : {}) });
      let at = offset;
      const timer = setInterval(() => { response.write(compiler.subarray(at, at + 65536)); at += 65536; if (at >= compiler.length) { clearInterval(timer); response.end(); } }, 25);
      response.on('close', () => { clearInterval(timer); closedTransfers++; });
      return;
    }
    const forwarded = httpRequest(upstream + request.url, { method: request.method, headers: { ...request.headers, host: `127.0.0.1:${port}` } }, (result) => { response.writeHead(result.statusCode ?? 500, result.headers); result.pipe(response); });
    forwarded.on('error', () => { response.statusCode = 502; response.end(); }); request.pipe(forwarded);
  });
  /** @type {import('playwright').Browser|undefined} */ let browser;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(upstream)).ok) break; } catch { /* Vite startup. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', () => resolve(undefined)));
    const address = proxy.address(); assert.ok(address && typeof address !== 'string');
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction(() => /** @type {any} */ (window).__wicroIde?.store.boards.length > 0);
    await page.selectOption('#wicro-example', 'stm32f103c8/swd-heartbeat');
    await page.click('#wicro-build');
    await page.locator('#wicro-transfer').waitFor({ state: 'visible' });
    await page.waitForFunction(() => /** @type {any} */ (window).__wicroIde.store.download?.received > 100000);
    await page.click('#wicro-transfer-pause');
    await page.waitForFunction(() => /** @type {any} */ (window).__wicroIde.store.download?.status === 'paused');
    assert.equal(await page.locator('#wicro-transfer-pause').innerText(), 'Resume');
    assert.match(await page.locator('#wicro-transfer-detail').innerText(), /Resume available/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(closedTransfers, 1);
    await page.click('#wicro-transfer-pause');
    await page.waitForFunction(() => /** @type {any} */ (window).__wicroIde.store.download?.status === 'downloading');
    assert.ok(ranges[1]?.startsWith('bytes='));
    await page.screenshot({ path: '/tmp/wicro-download-panel.png' });
    await page.click('#wicro-transfer-cancel');
    await page.waitForFunction(() => /** @type {any} */ (window).__wicroIde.store.buildStatus === 'error');
    assert.equal(await page.locator('#wicro-transfer').isVisible(), false);
    const logs = await page.evaluate(() => /** @type {any} */ (window).__wicroIde.store.compilerLogs);
    assert.ok(logs.length < 20, JSON.stringify(logs)); assert.match(logs.join('\n'), /cancelled/);
    assert.equal(ranges.length, 2, 'Cancel must not retry another mirror');
  } finally {
    await browser?.close(); proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(() => resolve(undefined))); vite.kill('SIGKILL');
  }
});
