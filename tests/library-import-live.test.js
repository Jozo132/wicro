import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

// Explicit network acceptance test: never substitute stand-ins for vendor code.
test('real Arduino SSD1306 dependencies and PlatformIO PubSubClient compile and link in the browser', { skip: process.env.WICRO_LIVE_LIBRARIES !== '1', timeout: 300000 }, async () => {
  const port = 6300 + Math.floor(Math.random() * 500);
  const proc = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve('apps/web'), stdio: 'ignore' });
  /** @type {import('playwright').Browser|undefined} */
  let browser;
  try {
    const origin = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(origin)).ok) break; } catch { /* Wait for Vite. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const page = await browser.newPage({ viewport: { width: 1512, height: 982 } });
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => /** @type {any} */ (window).__wicroIde?.store.boards.length > 0);
    await page.click('#wicro-libraries');
    /** @param {'arduino'|'platformio'} provider @param {string} query @param {string} name */
    const install = async (provider, query, name) => {
      await page.selectOption('#library-provider', provider);
      await page.fill('#library-query', query);
      await page.locator('#library-search-form button[type="submit"]').click();
      await page.waitForFunction(() => !document.querySelector('#library-status')?.textContent?.startsWith('Loading'), { timeout: 120000 });
      const card = page.locator('#library-results .library-card').filter({ has: page.locator('strong', { hasText: name }) }).first();
      assert.ok(await card.count(), await page.locator('#library-status').innerText());
      await card.locator('button').click();
      await page.waitForFunction(() => !document.querySelector('#library-status')?.textContent?.startsWith('Installing'), { timeout: 120000 });
      assert.match(await page.locator('#library-status').innerText(), /^Installed/);
    };
    await install('arduino', 'Adafruit SSD1306', 'Adafruit SSD1306');
    await install('platformio', 'name:PubSubClient owner:knolleary', 'PubSubClient');
    const dependencies = await page.evaluate(() => JSON.parse(/** @type {any} */ (window).__wicroIde.store.files.get('wicro-libraries.lock.json')).libraries.map((/** @type {any} */ entry) => entry.name));
    assert.ok(dependencies.includes('Adafruit SSD1306'));
    assert.ok(dependencies.includes('Adafruit GFX Library'));
    assert.ok(dependencies.includes('Adafruit BusIO'));
    assert.ok(dependencies.includes('Arduino ESP32 Wire and SPI'));
    assert.ok(dependencies.includes('PubSubClient'));
    await page.locator('#library-installed .library-card').filter({ hasText: 'Adafruit SSD1306' }).locator('.library-browse').click();
    await page.waitForFunction(() => Boolean(document.querySelector('#library-file-content')?.textContent));
    assert.ok((await page.locator('#library-file option').allTextContents()).includes('Adafruit_SSD1306.cpp'));
    await page.screenshot({ path: '/tmp/wicro-library-browser.png', fullPage: true });
    const build = await page.evaluate(async () => {
      const ide = /** @type {any} */ (window).__wicroIde;
      ide.store.setFileContent('main/main.ino', '#include <Adafruit_SSD1306.h>\n#include <PubSubClient.h>\nAdafruit_SSD1306 display(128, 64, &Wire, -1);\nPubSubClient mqtt;\nvoid setup() { display.begin(SSD1306_SWITCHCAPVCC, 0x3C); display.clearDisplay(); display.drawPixel(4, 4, SSD1306_WHITE); display.display(); mqtt.setServer("test.example", 1883); }\nvoid loop() {}\n');
      ide.editorHost.syncFiles(ide.store.files, 'main/main.ino');
      const result = await ide.runBuild();
      const hash = result?.artifacts?.bin ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', result.artifacts.bin))].map((byte) => byte.toString(16).padStart(2, '0')).join('') : null;
      return { hash, files: ide.store.snapshotFiles(), ok: result?.ok, diagnostics: result?.diagnostics, log: ide.store.compilerLogs.slice(-10), binSize: result?.artifacts?.bin?.byteLength, validation: result?.value?.validation, libraries: result?.value?.libraries };
    });
    assert.equal(build.ok, true, JSON.stringify(build));
    assert.ok(build.binSize > 50000);
    assert.equal(build.validation?.valid, true);
    assert.ok(build.libraries.length >= 5);
    await page.reload();
    await page.waitForFunction(() => /** @type {any} */ (window).__wicroIde?.store.boards.length > 0);
    const restored = await page.evaluate(() => {
      const ide = /** @type {any} */ (window).__wicroIde;
      ide.store.offline = true;
      return { libraries: ide.store.configuration.libraries.length, source: ide.store.files.get('main/main.ino') };
    });
    assert.equal(restored.libraries, 2);
    assert.match(restored.source, /Adafruit_SSD1306/);
    /** @type {string[]} */
    const externalRequests = [];
    // Deny vendor traffic while allowing lazy app/editor modules from dev:web.
    await page.context().route('**/*', async (route) => {
      if (route.request().url().startsWith(origin + '/')) await route.continue();
      else { externalRequests.push(route.request().url()); await route.abort(); }
    });
    const offline = await page.evaluate(async () => {
      const result = await /** @type {any} */ (window).__wicroIde.runBuild();
      const hash = result?.artifacts?.bin ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', result.artifacts.bin))].map((byte) => byte.toString(16).padStart(2, '0')).join('') : null;
      return { ok: result?.ok, hash, diagnostics: result?.diagnostics };
    });
    assert.equal(offline.ok, true, JSON.stringify(offline.diagnostics));
    assert.equal(offline.hash, build.hash, 'offline rebuild must reproduce the exact firmware bytes');
    assert.deepEqual(externalRequests, [], 'cached builds must not attempt vendor requests');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); proc.kill('SIGKILL'); }
});
