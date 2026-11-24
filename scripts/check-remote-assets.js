import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

// Opt-in live GET probes: intentionally separate from deterministic tests. These
// establish reachability/CORS, not archive integrity or firmware completeness.
const packageFilter = process.argv.find((arg) => arg.startsWith('--package='))?.slice('--package='.length);
const registryRoot = new URL('../registry/', import.meta.url);
/** @type {Array<{package:string,url:string}>} */
const candidates = [];
for (const directory of await readdir(registryRoot, { withFileTypes: true })) {
  if (!directory.isDirectory() || (packageFilter && packageFilter !== directory.name)) continue;
  const manifest = JSON.parse(await readFile(new URL(`${directory.name}/package.json`, registryRoot), 'utf8'));
  const distributions = [manifest.metadata?.distribution, ...Object.values(manifest.artifacts ?? {})];
  for (const distribution of distributions) {
    for (const url of [distribution?.url, ...(distribution?.mirrors ?? [])]) {
      if (typeof url === 'string' && /^https?:/.test(url)) candidates.push({ package: directory.name, url });
    }
  }
}
if (!candidates.length) throw new Error('No remote artifacts matched the requested registry package');

const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>Wicro remote asset probe</title>');
});
/** @type {import('playwright').Browser|undefined} */
let browser;
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}`);
  for (const candidate of candidates) {
    let node;
    try {
      const response = await fetch(candidate.url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
      await response.body?.cancel();
      node = { ok: response.ok, status: response.status, finalUrl: `${new URL(response.url).origin}${new URL(response.url).pathname}`, allowOrigin: response.headers.get('access-control-allow-origin') };
    } catch (error) { node = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    const browserResult = await page.evaluate(async (url) => {
      try {
        const response = await fetch(url, { mode: 'cors', credentials: 'omit', redirect: 'follow', signal: AbortSignal.timeout(20_000) });
        await response.body?.cancel();
        return { ok: response.ok, status: response.status, finalUrl: `${new URL(response.url).origin}${new URL(response.url).pathname}` };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    }, candidate.url);
    console.log(JSON.stringify({ ...candidate, probe: 'GET headers; body cancelled; SHA-256 not validated', node, browser: browserResult }));
    if (!browserResult.ok || !node.ok) process.exitCode = 1;
  }
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
