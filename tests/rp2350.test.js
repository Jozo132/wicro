import test from 'node:test';
import assert from 'node:assert/strict';
import { stat, readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { VSCodeHostAdapter } from '../packages/vscode/src/index.js';

test('RP2350 ARM and Hazard3 firmware match across CLI, VS Code and Chromium, including UF2 and offline reuse', { timeout: 180000 }, async () => {
  const vscode = new VSCodeHostAdapter({ workspaceRoot: process.cwd(), llvmPath: resolve('toolchain/llvm-wasm/cache/llvm.wasm') });
  /** @type {Map<string,{bin:string,elf:string,uf2:string}>} */ const expected = new Map();
  const hash = (/** @type {Uint8Array} */ bytes) => createHash('sha256').update(bytes).digest('hex');
  for (const board of ['rp2350', 'rp2350-riscv']) {
    const project = `examples/${board}/usb-heartbeat`;
    const cli = spawnSync(process.execPath, ['packages/wicro/bin/wicro.js', 'build', `--project=${project}`, '--json'], { encoding: 'utf8', timeout: 120000 });
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    const result = JSON.parse(cli.stdout);
    const uf2Path = `examples/${board}/usb-heartbeat/.wicro/build/firmware.uf2`;
    const bin = hash(await readFile(result.bin)), elf = hash(await readFile(result.elf)), uf2 = hash(await readFile(uf2Path));
    assert.ok(result.binBytes < (2097152));
    const vs = await vscode.buildProject({ project, offline: true }); assert.equal(vs.ok, true, JSON.stringify(vs.diagnostics));
    assert.equal(hash(await readFile(result.bin)), bin); assert.equal(hash(await readFile(result.elf)), elf);
    assert.equal(hash(await readFile(uf2Path)), uf2);
    expected.set(board, { bin, elf, uf2 });
  }
  const port = 8700 + Math.floor(Math.random() * 500), origin = `http://127.0.0.1:${port}`;
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
    for (const board of ['rp2350', 'rp2350-riscv']) {
      await page.selectOption('#wicro-example', `${board}/usb-heartbeat`);
      assert.equal(await page.locator('#config-framework').inputValue(), 'bare-metal');
      assert.equal(await page.locator('#config-programmer').inputValue(), 'rp2350-picoboot');
      assert.equal(await page.locator('#config-protocol').inputValue(), 'picoboot');
      assert.equal(await page.locator('#config-upload-baud').count(), 0);
      const build = await page.evaluate(async () => {
        const ide = /** @type {any} */ (window).__wicroIde;
        const hash = async (/** @type {Uint8Array} */ bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        const result = await ide.runBuild();
        if (!result?.ok) return { ok: false, logs: ide.store.compilerLogs, bin: '', elf: '', uf2: '', offline: false };
        const hashes = { bin: await hash(result.artifacts.bin), elf: await hash(result.artifacts.elf), uf2: await hash(result.artifacts.uf2) };
        ide.store.offline = true;
        const offline = await ide.runBuild(); ide.store.offline = false;
        return { ok: true, ...hashes, offline: offline?.ok && await hash(offline.artifacts.bin) === hashes.bin };
      });
      assert.equal(build.ok, true, JSON.stringify(build));
      assert.equal(build.bin, expected.get(board)?.bin, `${board} BIN parity`);
      assert.equal(build.elf, expected.get(board)?.elf, `${board} ELF parity`);
      assert.equal(build.uf2, expected.get(board)?.uf2, `${board} UF2 parity`);
      assert.equal(await page.locator('[data-dl=uf2]').count(), 1);
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-dl=uf2]').click()]);
      const downloadedPath = await download.path(); assert.ok(downloadedPath);
      assert.equal(hash(await readFile(downloadedPath)), expected.get(board)?.uf2);
      assert.equal(download.suggestedFilename(), `${board}-firmware.uf2`);
      assert.equal(build.offline, true);
    }
    await page.screenshot({ path: '/tmp/wicro-rp2350.png', fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); vite.kill('SIGKILL'); }
});

test('RP2350 rejects wrong architecture metadata, entry/stack and malformed or mixed-family UF2', async () => {
  const { validateRp2350Image, rp2350BinToUf2, rp2350Uf2ToBin, elfToRp2350Bin } = await import('../packages/runtime/src/rp2350-image.js');
  for (const board of ['rp2350', 'rp2350-riscv']) {
    const image = new Uint8Array(await readFile(`examples/${board}/usb-heartbeat/.wicro/build/firmware.bin`));
    const wrongElf = new Uint8Array(await readFile(`examples/${board}/usb-heartbeat/.wicro/build/firmware.elf`));
    new DataView(wrongElf.buffer).setUint16(18, board === 'rp2350' ? 243 : 40, true);
    await assert.rejects(() => elfToRp2350Bin(wrongElf), /architecture does not match/);
    const info = validateRp2350Image(image);
    assert.equal(info.architecture, board === 'rp2350' ? 'armv8m-mainline' : 'riscv32');
    for (const offset of [8, 12, board === 'rp2350' ? 0 : 24, board === 'rp2350' ? 4 : 20]) {
      const invalid = image.slice(); new DataView(invalid.buffer).setUint32(offset, 0, true);
      assert.throws(() => validateRp2350Image(invalid));
    }
    const uf2 = rp2350BinToUf2(image);
    const reordered = new Uint8Array(uf2.length);
    for (let at = 0; at < uf2.length; at += 512) reordered.set(uf2.subarray(at, at + 512), uf2.length - at - 512);
    assert.deepEqual(rp2350Uf2ToBin(reordered).subarray(0,image.length), image);
    const duplicate = uf2.slice(); duplicate.set(uf2.subarray(0,512),512);
    assert.throws(() => rp2350Uf2ToBin(duplicate));
    const mixed = uf2.slice(); new DataView(mixed.buffer).setUint32(512 + 28, 0xe48bff56, true);
    assert.throws(() => rp2350Uf2ToBin(mixed));
    const swapped = uf2.slice(), v = new DataView(swapped.buffer);
    for (let at = 0; at < swapped.length; at += 512) v.setUint32(at + 28, board === 'rp2350' ? 0xe48bff5a : 0xe48bff59, true);
    assert.throws(() => rp2350Uf2ToBin(swapped), /architecture mismatch/);
  }
});
