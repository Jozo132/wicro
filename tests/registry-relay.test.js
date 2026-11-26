import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { relayArtifact } from '../services/registry-relay/worker.js';

test('artifact relay validates redirect hops and streams ranges without forwarding credentials', async () => {
  const body = new TextEncoder().encode('verified-public-artifact');
  let calls = 0;
  const server = createServer((request, response) => {
    calls++; assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined);
    if (request.url === '/download/ok') { response.writeHead(302, { Location: 'https://github.com/ivankravets/pioreg-ci-mirror/releases/download/tag/item' }); response.end(); return; }
    if (request.url === '/download/evil') { response.writeHead(302, { Location: 'https://127.0.0.1/private' }); response.end(); return; }
    if (request.url === '/download/loop') { response.writeHead(302, { Location: 'https://dl.registry.platformio.org/download/loop' }); response.end(); return; }
    assert.equal(request.headers.range, 'bytes=3-'); assert.equal(request.headers['if-range'], '"v1"');
    response.writeHead(206, { 'Content-Length': body.length - 3, 'Content-Range': `bytes 3-${body.length - 1}/${body.length}`, ETag: '"v1"', 'Accept-Ranges': 'bytes', 'Set-Cookie': 'must-not-pass=1' }); response.end(body.subarray(3));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const transport = (/** @type {URL|RequestInfo} */ url, /** @type {RequestInit|undefined} */ options) => fetch(`http://127.0.0.1:${address.port}${new URL(String(url)).pathname}`, options);
  const request = (/** @type {string} */ url) => new Request('https://relay.test/?url=' + encodeURIComponent(url), { headers: { Range: 'bytes=3-', 'If-Range': '"v1"', Authorization: 'test-only', Cookie: 'test-only' } });
  try {
    const response = await relayArtifact(request('https://dl.registry.platformio.org/download/ok'), { fetch: transport });
    assert.equal(response.status, 206); assert.equal(response.headers.get('access-control-allow-origin'), '*'); assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), body.subarray(3));
    const before = calls;
    for (const url of ['http://dl.registry.platformio.org/download/ok', 'https://example.com/file', 'https://user:pass@github.com/ivankravets/pioreg-ci-mirror/releases/download/tag/item', 'https://dl.registry.platformio.org:444/download/ok']) assert.equal((await relayArtifact(request(url), { fetch: transport })).status, 403);
    assert.equal(calls, before);
    for (const url of ['https://github.com/owner/repo/releases/download/tag/item', 'https://codeload.github.com/owner/repo/zip/refs/tags/v1', 'https://raw.githubusercontent.com/owner/repo/main/file.bin', 'https://objects.githubusercontent.com/github-production-release-asset-123/item']) assert.equal((await relayArtifact(request(url), { fetch: transport })).status, 206);
    assert.equal((await relayArtifact(request('https://dl.registry.platformio.org/download/evil'), { fetch: transport })).status, 403);
    assert.equal((await relayArtifact(request('https://dl.registry.platformio.org/download/loop'), { fetch: transport })).status, 508);
    assert.equal((await relayArtifact(new Request('https://relay.test/', { method: 'POST' }), { fetch: transport })).status, 405);
    assert.equal((await relayArtifact(new Request('https://relay.test/', { method: 'OPTIONS' }), { fetch: transport })).status, 204);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(() => resolve(undefined))); }
});
