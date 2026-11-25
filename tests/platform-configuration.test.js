import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

test('platform setup: dependent fields and two-way Monaco JSON synchronization', async () => {
  const port = 5200 + Math.floor(Math.random() * 1000);
  const proc = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve('apps/web'), stdio: 'ignore' });
  /** @type {import('playwright').Browser|undefined} */
  let browser;
  try {
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (proc.exitCode !== null) throw new Error(`Vite exited: ${proc.exitCode}`);
      try { if ((await fetch(origin)).ok) { ready = true; break; } } catch { /* Startup polling. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Vite must start');
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const page = await browser.newPage({ viewport: { width: 1512, height: 982 } });
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => /** @type {any} */ (window).__wicroIde?.store.boards.length > 0);
    /** @returns {Promise<any>} */
    const json = () => page.evaluate(() => JSON.parse(/** @type {any} */ (window).__wicroIde.store.files.get('wicro.json')));
    await page.selectOption('#config-optimization', '-Oz');
    await page.check('#config-debug');
    await page.check('#config-warnings');
    await page.fill('#config-defines', 'FEATURE_ENABLED=1\nLOG_LEVEL=2');
    await page.locator('#config-defines').blur();
    let config = await json();
    assert.ok(config.build.flags.includes('-Oz'));
    assert.ok(config.build.flags.includes('-g'));
    assert.ok(config.build.flags.includes('-Wall'));
    assert.deepEqual(config.build.defines, ['FEATURE_ENABLED=1', 'LOG_LEVEL=2']);
    assert.deepEqual(config.build.sources, ['main/main.ino']);
    assert.equal(await page.locator('#config-clock').isDisabled(), true);

    await page.uncheck('#config-verify');
    assert.equal(await page.locator('#config-verification-fields').isVisible(), false);
    await page.uncheck('#config-auto-monitor');
    assert.equal(await page.locator('#config-monitor-fields').isVisible(), false);
    assert.equal((await json()).upload.verify, 'none');
    await page.selectOption('#config-programmer', 'none');
    assert.equal(await page.locator('#config-upload-fields').isVisible(), false);
    await page.selectOption('#config-programmer', 'esp32-c3-usb-jtag');
    assert.equal(await page.locator('#config-upload-fields').isVisible(), true);
    await page.fill('#config-upload-baud', '230400');
    await page.locator('#config-upload-baud').blur();
    assert.equal((await json()).upload.baudRate, 230400);

    await page.click('#config-edit-json');
    config = await json();
    config.board = 'stm32f103cb';
    config.framework = 'bare-metal';
    config.upload = { programmer: 'none' };
    config.build.flags = ['-O2'];
    config.packages = { 'custom-library': '^1.2.3' };
    /** @param {string} text */
    const editJson = async (text) => page.evaluate((value) => {
      const ide = /** @type {any} */ (window).__wicroIde;
      ide.store.setActiveFile('wicro.json');
      ide.editorHost.openFile('wicro.json');
      ide.editorHost.editor.getModel().setValue(value);
    }, text);
    await editJson(JSON.stringify(config, null, 2));
    assert.equal(await page.locator('#config-family').inputValue(), 'STM32');
    assert.equal(await page.locator('#config-model').inputValue(), 'STM32F103CB');
    assert.equal(await page.locator('#config-board').inputValue(), 'stm32f103cb');
    assert.equal(await page.locator('#wicro-board').inputValue(), 'stm32f103cb');
    assert.equal(await page.locator('#config-optimization').inputValue(), '-O2');
    assert.equal(await page.locator('#config-debug').isChecked(), false);
    assert.equal(await page.locator('#wicro-build').isDisabled(), true);
    assert.match(await page.locator('#config-errors').innerText(), /Arduino sketch sources/);
    assert.equal(await page.locator('#config-upload-fields').isVisible(), false);
    await page.selectOption('#config-optimization', '-Os');
    const modelText = await page.evaluate(() => /** @type {any} */ (window).__wicroIde.editorHost.models.get('wicro.json').getValue());
    assert.equal(JSON.parse(modelText).build.flags[0], '-Os');
    assert.equal(JSON.parse(modelText).packages['custom-library'], '^1.2.3');

    await editJson('{ "board":');
    assert.equal(await page.locator('#config-family').isDisabled(), true);
    assert.equal(await page.locator('#wicro-build').isDisabled(), true);
    assert.equal(await page.locator('#config-errors').isVisible(), true);
    await editJson(modelText);
    assert.equal(await page.locator('#config-family').isDisabled(), false);

    await page.selectOption('#wicro-board', 'stm32f401rc');
    await page.selectOption('#config-programmer', 'stm32-cdc-dfu');
    assert.equal(await page.locator('#config-protocol').inputValue(), 'dfuse');
    assert.equal(await page.locator('#config-upload-baud').count(), 0);
    assert.equal(await page.locator('#config-enter-dfu').count(), 1);
    assert.equal(await page.locator('#config-verify').count(), 0, 'DFU readback is required');
    assert.equal((await json()).upload.programmer, 'stm32-cdc-dfu');
    assert.equal(await page.locator('#config-auto-monitor').count(), 0);

    await page.selectOption('#wicro-example', 'esp8266/bare-metal-heartbeat');
    assert.equal(await page.locator('#config-programmer').inputValue(), 'esp8266-uart');
    assert.equal(await page.locator('#config-framework').inputValue(), 'bare-metal');
    assert.equal(await page.locator('#config-upload-baud').isDisabled(), true);
    assert.equal(await page.locator('#config-verify').count(), 0);
    const espBuild = await page.evaluate(async () => {
      const ide = /** @type {any} */ (window).__wicroIde;
      const result = await ide.runBuild();
      return { ok: result?.ok, bin: [...(result?.artifacts?.bin ?? [])], log: ide.store.compilerLog };
    });
    assert.equal(espBuild.ok, true, JSON.stringify(espBuild.log));
    const { validateEsp8266Image } = await import('../packages/runtime/src/esp8266-image.js');
    assert.equal(validateEsp8266Image(Uint8Array.from(espBuild.bin)).segmentCount, 2);

    await page.selectOption('#wicro-example', 'esp32-original/bare-metal-heartbeat');
    assert.equal(await page.locator('#config-programmer').inputValue(), 'esp32-original-uart');
    assert.equal(await page.locator('#config-framework').inputValue(), 'bare-metal');
    assert.equal(await page.locator('#config-upload-baud').isDisabled(), true);
    assert.equal(await page.locator('#config-verify').count(), 0);
    const originalBuild = await page.evaluate(async () => {
      const ide = /** @type {any} */ (window).__wicroIde;
      const result = await ide.runBuild();
      return { ok: result?.ok, bin: [...(result?.artifacts?.bin ?? [])], log: ide.store.compilerLog };
    });
    assert.equal(originalBuild.ok, true, JSON.stringify(originalBuild.log));
    const { validateEsp32OriginalImage } = await import('../packages/runtime/src/esp32-original-image.js');
    assert.equal(validateEsp32OriginalImage(Uint8Array.from(originalBuild.bin)).valid, true);

    await page.selectOption('#wicro-example', 'arduino-nano/heartbeat');
    assert.equal(await page.locator('#config-programmer').inputValue(), 'nano-stk500v1');
    assert.equal(await page.locator('#config-protocol').inputValue(), 'stk500v1');
    await page.selectOption('#config-upload-baud', '57600');
    assert.equal((await json()).upload.baudRate, 57600);
    await page.selectOption('#config-upload-baud', '115200');
    if (await stat('dist/assets/nano-arduino-sdk-1.0.0.zip').then(() => true, () => false)) {
      const nanoBuild = await page.evaluate(async () => {
        const ide = /** @type {any} */ (window).__wicroIde;
        const result = await ide.runBuild();
        return { ok: result?.ok, bytes: result?.artifacts?.bin?.length, log: ide.store.compilerLog };
      });
      assert.equal(nanoBuild.ok, true, JSON.stringify(nanoBuild.log));
      assert.ok(nanoBuild.bytes > 1000 && nanoBuild.bytes <= 30720);
    }
    await page.selectOption('#wicro-example', 'rp2040-zero/usb-heartbeat');
    assert.equal(await page.locator('#config-programmer').inputValue(), 'rp2040-picoboot');
    assert.equal(await page.locator('#config-protocol').inputValue(), 'picoboot');
    assert.equal(await page.locator('#config-upload-baud').count(), 0);
    assert.equal(await page.locator('#config-auto-monitor').count(), 0);
    assert.equal(await page.locator('#config-enter-rp-rom').count(), 1);
    const rpBuild = await page.evaluate(async () => {
      const ide = /** @type {any} */ (window).__wicroIde;
      const result = await ide.runBuild();
      return { ok: result?.ok, bin: [...(result?.artifacts?.bin ?? [])], log: ide.store.compilerLog };
    });
    assert.equal(rpBuild.ok, true, JSON.stringify(rpBuild.log));
    const { validateRp2040Image } = await import('../packages/runtime/src/rp2040-image.js');
    assert.equal(validateRp2040Image(Uint8Array.from(rpBuild.bin)).valid, true);
    const sourcesBeforeFamilyChange = (await json()).build.sources;
    await page.selectOption('#config-family', 'RP2350');
    assert.ok((await page.locator('#config-model option').allTextContents()).every((name) => name.includes('RP2350')));
    assert.equal((await json()).board, await page.locator('#config-board').inputValue());
    assert.deepEqual((await json()).build.sources, sourcesBeforeFamilyChange, 'target selection must preserve example sources');
    await page.selectOption('#wicro-board', 'esp32-c3-supermini');
    assert.equal(await page.locator('#config-family').inputValue(), 'ESP32');
    assert.deepEqual(errors, []);
    await page.locator('#wicro-platform-configuration').evaluate((element) => { element.scrollTop = 0; });
    await page.screenshot({ path: '/tmp/wicro-platform-configuration-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '/tmp/wicro-platform-configuration-mobile.png', fullPage: true });
    const bounds = await page.locator('#wicro-platform-configuration').boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391);
    await page.click('#config-close');
    assert.equal(await page.locator('#wicro-platform-configuration').isVisible(), false);
    await page.click('#wicro-configure');
    assert.equal(await page.locator('#wicro-platform-configuration').isVisible(), true);
  } finally {
    await browser?.close();
    proc.kill('SIGKILL');
  }
});
