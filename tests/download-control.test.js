import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { downloadBytes, DownloadControl } from '../packages/registry/src/download.js';

test('real HTTP downloads pause, resume with validated Range, restart without ranges, and cancel', async () => {
  const bytes = Uint8Array.from({ length: 256 * 1024 }, (_, index) => index % 251);
  /** @type {{path:string,range:string|undefined}[]} */ const requests = [];
  const server = createServer((request, response) => {
    const path = request.url ?? '/'; requests.push({ path, range: request.headers.range });
    const offset = path === '/range' && request.headers.range ? Number(request.headers.range.match(/bytes=(\d+)-/)?.[1]) : 0;
    response.writeHead(offset ? 206 : 200, { 'Content-Length': bytes.length - offset, ETag: '"immutable-v1"', ...(path === '/range' ? { 'Accept-Ranges': 'bytes' } : {}), ...(offset ? { 'Content-Range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {}) });
    let at = offset;
    const timer = setInterval(() => {
      response.write(bytes.subarray(at, at + 4096)); at += 4096;
      if (at >= bytes.length) { clearInterval(timer); response.end(); }
    }, 8);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const path of ['/range', '/restart']) {
      const control = new DownloadControl(); let paused = false, updates = 0;
      const result = await downloadBytes(base + path, { control, progress: (event) => {
        updates++;
        if (!paused && event.received > 32768) { paused = true; control.pause(); setTimeout(() => control.resume(), 40); }
      } });
      assert.deepEqual(result, bytes); assert.equal(paused, true); assert.ok(updates < 20, 'Progress must be throttled');
      const hits = requests.filter((request) => request.path === path);
      assert.equal(hits.length, 2);
      assert.equal(Boolean(hits[1].range), path === '/range');
    }
    const control = new DownloadControl();
    await assert.rejects(() => downloadBytes(base + '/cancel', { control, progress: (event) => { if (event.received > 0) control.cancel(); } }), { name: 'AbortError' });
    assert.equal(requests.filter((request) => request.path === '/cancel').length, 1);
    const paused = new DownloadControl(); paused.pause(); const waiting = downloadBytes(base + '/never', { control: paused }); paused.cancel();
    await assert.rejects(() => waiting, { name: 'AbortError' });
    assert.equal(requests.filter((request) => request.path === '/never').length, 0);
  } finally { server.closeAllConnections(); await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(undefined))); }
});
