import test from 'node:test';
import assert from 'node:assert/strict';
import { stat, readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { VSCodeHostAdapter } from '../packages/vscode/src/index.js';

const sdkReady = await Promise.all(['f1', 'f4'].map((family) => stat(`dist/assets/stm32-${family}-arduino-sdk-1.0.0.zip`).then(() => true, () => false))).then((values) => values.every(Boolean));
test('genuine F103/F401 Arduino core, USB and bundled libraries build identically in CLI, VS Code and Chromium with offline reuse', { skip: sdkReady ? false : 'Precompose verified STM32 SDKs with scripts/package-stm32-sdk.js', timeout: 300000 }, async () => {
  const vscode = new VSCodeHostAdapter({ workspaceRoot: process.cwd(), llvmPath: resolve('toolchain/llvm-wasm/cache/llvm.wasm') });
  /** @type {Map<string,{bin:string,elf:string}>} */ const expected = new Map();
  const hash = (/** @type {Uint8Array} */ bytes) => createHash('sha256').update(bytes).digest('hex');
  for (const board of ['stm32f103c8', 'stm32f401rc']) {
    const project = `examples/${board}/arduino-usb-heartbeat`;
    const cli = spawnSync(process.execPath, ['packages/wicro/bin/wicro.js', 'build', `--project=${project}`, '--json'], { encoding: 'utf8', timeout: 120000 });
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    const result = JSON.parse(cli.stdout);
    const bin = hash(await readFile(result.bin)), elf = hash(await readFile(result.elf));
    assert.ok(result.binBytes < (board === 'stm32f103c8' ? 65536 : 262144));
    const vs = await vscode.buildProject({ project, offline: true }); assert.equal(vs.ok, true, JSON.stringify(vs.diagnostics));
    assert.equal(hash(await readFile(result.bin)), bin); assert.equal(hash(await readFile(result.elf)), elf);
    expected.set(board, { bin, elf });
  }
  const port = 7600 + Math.floor(Math.random() * 500), origin = `http://127.0.0.1:${port}`;
  const vite = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve('apps/web'), stdio: 'ignore' });
  /** @type {import('playwright').Browser|undefined} */ let browser;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(origin)).ok) break; } catch { /* Vite startup. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    /** @type {string[]} */ const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => /** @type {any} */ (window).__wicroIde?.store.boards.length > 0);
    for (const board of ['stm32f103c8', 'stm32f401rc']) {
      await page.selectOption('#wicro-example', `${board}/arduino-usb-heartbeat`);
      assert.equal(await page.locator('#config-framework').inputValue(), 'arduino');
      const build = await page.evaluate(async () => {
        const ide = /** @type {any} */ (window).__wicroIde;
        const hash = async (/** @type {Uint8Array} */ bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        const result = await ide.runBuild();
        if (!result?.ok) return { ok: false, logs: ide.store.compilerLogs, bin: '', elf: '', offline: false };
        const hashes = { bin: await hash(result.artifacts.bin), elf: await hash(result.artifacts.elf) };
        ide.store.offline = true;
        const offline = await ide.runBuild(); ide.store.offline = false;
        return { ok: true, ...hashes, offline: offline?.ok && await hash(offline.artifacts.bin) === hashes.bin };
      });
      assert.equal(build.ok, true, JSON.stringify(build));
      assert.equal(build.bin, expected.get(board)?.bin, `${board} BIN parity`);
      assert.equal(build.elf, expected.get(board)?.elf, `${board} ELF parity`);
      assert.equal(build.offline, true);
    }
    await page.screenshot({ path: '/tmp/wicro-stm32-arduino.png', fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); vite.kill('SIGKILL'); }
});
