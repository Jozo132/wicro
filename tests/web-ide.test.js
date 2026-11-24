import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { validateEsp32Image } from '../packages/runtime/src/elf-utils.js';

const sdkArchivePath = resolve('dist/assets/esp32-c3-sdk-4.20017.260907.zip');
const llvmPath = resolve('toolchain/llvm-wasm/cache/llvm.wasm');

/** @param {string} filePath */
const fileExists = async (filePath) => {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
};

/**
 * Start the `@wicro/web` Vite dev server on a free port and wait until it responds.
 * Uses `process.execPath` directly against Vite's CLI entry point so `proc.kill()`
 * terminates the server cleanly without leaving an `npx` grandchild process open.
 * @param {number} port
 */
const startViteServer = async (port) => {
  const viteBin = resolve('node_modules/vite/bin/vite.js');
  const proc = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: resolve('apps/web'),
    stdio: 'ignore'
  });
  proc.unref();

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Vite dev server exited prematurely with code ${proc.exitCode}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return { proc, baseUrl };
    } catch {
      // Wait for Vite to bind.
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  proc.kill('SIGKILL');
  throw new Error('Timed out waiting for Vite dev server to start');
};

/**
 * Launch Chromium using Playwright's default binary, falling back to system Chrome/Chromium
 * when the exact Playwright browser revision is not downloaded.
 */
const launchChromium = async () => {
  try {
    return await chromium.launch({ headless: true });
  } catch {
    try {
      return await chromium.launch({ headless: true, channel: 'chrome' });
    } catch {
      return await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome' });
    }
  }
};

test('Browser IDE: UI, project explorer, Monaco editor, WASM ESP32-C3 build, diagnostics, and offline OPFS rebuild', async (t) => {
  const hasLlvm = await fileExists(llvmPath);
  const hasSdk = await fileExists(sdkArchivePath);
  if (!hasLlvm) {
    t.skip('toolchain/llvm-wasm/cache/llvm.wasm not present');
    return;
  }

  const port = 4173 + Math.floor(Math.random() * 1000);
  const { proc, baseUrl } = await startViteServer(port);
  /** @type {import('playwright').Browser | null} */
  let browser = null;

  try {
    browser = await launchChromium();
    const context = await browser.newContext();
    const page = await context.newPage();

    /** @type {string[]} */
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    // 1. Canonical boards and examples loaded into UI selectors
    await page.waitForFunction(() => {
      const ide = /** @type {any} */ (window).__wicroIde;
      return ide && ide.store.boards.length > 0 && ide.store.examples.length > 0;
    }, { timeout: 15_000 });

    const initialState = await page.evaluate(() => {
      const ide = /** @type {any} */ (window).__wicroIde;
      return {
        boardId: ide.store.boardId,
        exampleId: ide.store.exampleId,
        boardCount: ide.store.boards.length,
        exampleCount: ide.store.examples.length,
        activeFile: ide.store.activeFile,
        source: ide.store.files.get(ide.store.activeFile)
      };
    });

    assert.equal(initialState.boardId, 'esp32-c3-supermini');
    assert.equal(initialState.exampleId, 'esp32-c3-supermini/blink');
    assert.ok(initialState.boardCount >= 10, 'Expected canonical boards from registry/');
    assert.ok(initialState.exampleCount >= 5, 'Expected canonical examples from examples/');
    assert.ok(initialState.source?.includes('WICRO_SERIAL_READY'));

    // 2. Theme toggle and multi-file explorer interactions
    await page.click('#wicro-theme');
    assert.equal(await page.getAttribute('.wicro-ide', 'data-theme'), 'light');
    await page.click('#wicro-theme');
    assert.equal(await page.getAttribute('.wicro-ide', 'data-theme'), 'dark');

    await page.evaluate(() => {
      const ide = /** @type {any} */ (window).__wicroIde;
      ide.store.addFile('main/config.h', '#pragma once\n#define BLINK_DELAY_MS 500\n');
      ide.editorHost.syncFiles(ide.store.files, ide.store.activeFile);
    });
    assert.equal(await page.locator('#wicro-file-list .file-item').count(), 3);

    // Switch back to main/main.ino
    await page.click('#wicro-file-list .file-name:has-text("main/main.ino")');
    assert.equal(await page.evaluate(() => /** @type {any} */ (window).__wicroIde.store.activeFile), 'main/main.ino');

    if (!hasSdk) {
      // Without local ESP32-C3 SDK archive, verify STM32 bare-metal WASM compile+link in browser
      await page.selectOption('#wicro-example', 'stm32f103cb/bare-metal-blink');
      const stmResult = await page.evaluate(async () => {
        const ide = /** @type {any} */ (window).__wicroIde;
        const res = await ide.runBuild();
        return { ok: res?.ok, binLen: res?.artifacts?.bin?.byteLength ?? 0 };
      });
      assert.equal(stmResult.ok, true, 'STM32 bare-metal browser WASM build failed');
      assert.ok(stmResult.binLen > 0, 'Expected non-empty STM32 firmware.bin');
      assert.deepEqual(pageErrors, []);
      return;
    }

    // 3. Full browser WASM compile + link + ESP32-C3 BIN generation & validation
    const build1 = await page.evaluate(async () => {
      const ide = /** @type {any} */ (window).__wicroIde;
      const res = await ide.runBuild();
      return {
        ok: res?.ok,
        binBytes: res?.artifacts?.bin ? Array.from(res.artifacts.bin) : [],
        elfLen: res?.artifacts?.elf?.byteLength ?? 0,
        validation: res?.value?.validation,
        memory: res?.value?.memory,
        cacheStatus: res?.cacheStatus,
        timingMs: res?.timingMs
      };
    });

    assert.equal(build1.ok, true, 'Browser ESP32-C3 WASM build failed');
    assert.ok(build1.elfLen > 100_000, `Expected full ESP32-C3 ELF, got ${build1.elfLen} bytes`);
    assert.ok(build1.binBytes.length > 50_000, `Expected full ESP32-C3 BIN, got ${build1.binBytes.length} bytes`);
    assert.equal(build1.validation?.valid, true);
    assert.equal(build1.validation?.chipId, 5);
    assert.equal(build1.validation?.hasAppDesc, true);
    assert.equal(build1.validation?.sha256Valid, true);
    assert.ok(build1.memory?.totalFlashBytes > 0);

    // Independently validate the generated BIN in Node as well
    const browserBin = Uint8Array.from(build1.binBytes);
    const independentCheck = await validateEsp32Image(browserBin);
    assert.equal(independentCheck.valid, true, independentCheck.errors.join('; '));
    assert.equal(independentCheck.sha256Valid, true);

    // Compare against Node CLI-built BIN if present (same canonical pipeline)
    const cliBinPath = resolve('examples/esp32-c3-supermini/blink/.wicro/build/firmware.bin');
    if (await fileExists(cliBinPath)) {
      const cliBin = await readFile(cliBinPath);
      assert.equal(browserBin.byteLength, cliBin.byteLength, 'Browser and Node CLI ESP32-C3 firmware.bin sizes must match');
    }

    // 4. Verify compiler diagnostics on intentional syntax error
    const diagBuild = await page.evaluate(async () => {
      const ide = /** @type {any} */ (window).__wicroIde;
      const original = ide.store.files.get('main/main.ino');
      ide.store.setFileContent('main/main.ino', 'void setup() { unknown_symbol_xyz(); }\nvoid loop() {}\n');
      ide.editorHost.syncFiles(ide.store.files, 'main/main.ino');
      const res = await ide.runBuild();
      // Restore original valid source
      ide.store.setFileContent('main/main.ino', original);
      ide.editorHost.syncFiles(ide.store.files, 'main/main.ino');
      return {
        ok: res?.ok,
        diagCount: ide.store.diagnostics.length,
        firstDiag: ide.store.diagnostics[0]
      };
    });

    assert.equal(diagBuild.ok, false, 'Expected build failure on undefined symbol');
    assert.ok(diagBuild.diagCount > 0, 'Expected parsed Clang diagnostics');
    assert.equal(diagBuild.firstDiag?.severity, 'error');

    // 5. Reload page and rebuild OFFLINE using persistent OPFS cache
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => {
      const ide = /** @type {any} */ (window).__wicroIde;
      return ide && ide.store.boards.length > 0 && ide.store.examples.length > 0;
    }, { timeout: 15_000 });

    await page.check('#wicro-offline');
    const offlineBuild = await page.evaluate(async () => {
      const ide = /** @type {any} */ (window).__wicroIde;
      const res = await ide.runBuild();
      return {
        ok: res?.ok,
        binLen: res?.artifacts?.bin?.byteLength ?? 0,
        cacheStatus: res?.cacheStatus
      };
    });

    assert.equal(offlineBuild.ok, true, 'Offline rebuild using OPFS cache failed');
    assert.equal(offlineBuild.binLen, browserBin.byteLength, 'Offline rebuild must produce identical BIN size');
    assert.equal(offlineBuild.cacheStatus?.compiler, 'cache-hit');
    assert.equal(offlineBuild.cacheStatus?.sdk, 'cache-hit');
    // Prove visual settings reach the real compiler, including offline cache reuse.
    await page.selectOption('#config-optimization', '-O2');
    await page.fill('#config-defines', 'WICRO_CONFIGURATION_TEST=37');
    await page.locator('#config-defines').blur();
    const configuredBuild = await page.evaluate(async () => {
      const ide = /** @type {any} */ (window).__wicroIde;
      const source = ide.store.files.get('main/main.ino');
      ide.store.setFileContent('main/main.ino', '#if WICRO_CONFIGURATION_TEST != 37\n#error Configuration define did not reach the compiler\n#endif\n' + source);
      const result = await ide.runBuild();
      return { ok: result?.ok, binSize: result?.artifacts?.bin?.byteLength, diagnostics: result?.diagnostics };
    });
    assert.equal(configuredBuild.ok, true, JSON.stringify(configuredBuild.diagnostics));
    assert.ok(configuredBuild.binSize > 50_000);
    const changedDuringBuild = await page.evaluate(async () => {
      const ide = /** @type {any} */ (window).__wicroIde;
      const pending = ide.runBuild();
      ide.store.setFileContent('main/main.ino', ide.store.files.get('main/main.ino') + '\n// Edited during compilation\n');
      const result = await pending;
      return { result, hasArtifacts: Boolean(ide.store.lastBuild), message: ide.store.buildProgress.message };
    });
    assert.equal(changedDuringBuild.result, null);
    assert.equal(changedDuringBuild.hasArtifacts, false);
    assert.match(changedDuringBuild.message, /Project changed during build/);

    assert.deepEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join('; ')}`);
  } finally {
    if (browser) await browser.close();
    proc.kill('SIGKILL');
  }
});
