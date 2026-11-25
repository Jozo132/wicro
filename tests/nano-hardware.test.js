import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { SerialPort } from 'serialport';
import { createHash } from 'node:crypto';
import { NanoNodeProgrammer } from '../packages/programmers/src/stk500-node.js';

test('Nano Arduino WASM firmware, STK500 readback, bootloader preservation and 65-second serial stability', { skip: process.env.WICRO_NANO_HARDWARE !== '1', timeout: 120000 }, async () => {
  const path = process.env.WICRO_NANO_PORT;
  assert.ok(path, 'WICRO_NANO_PORT must explicitly select the connected Nano');
  const baudRate = Number(process.env.WICRO_NANO_BAUD ?? 115200);
  const build = (/** @type {string[]} */ flags = []) => {
    const result = spawnSync(process.execPath, ['packages/wicro/bin/wicro.js', 'build', '--project=examples/arduino-nano/heartbeat', '--json', ...flags], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stdout + result.stderr); return JSON.parse(result.stdout);
  };
  const built = build(), image = new Uint8Array(await readFile(built.bin));
  const programmer = new NanoNodeProgrammer({ path, baudRate });
  const bootBefore = await programmer.session((p) => p.readFlash(30720, 2048));
  const flashed = await programmer.writeFlash(image);
  const p = new SerialPort({ path, baudRate: 115200, autoOpen: false });
  let text = '';
  /** @type {{line:string,time:number}[]} */
  const lines = [];
  let pending = '';
  p.on('data', (bytes) => { text += bytes.toString(); pending += bytes.toString(); const parts = pending.split(/\r?\n/); pending = parts.pop() ?? ''; for (const line of parts) if (line.startsWith('WICRO_NANO_')) lines.push({ line, time: Date.now() }); });
  await new Promise((resolve, reject) => p.open((error) => error ? reject(error) : resolve(undefined)));
  let start;
  try {
    await new Promise((resolve, reject) => p.set({ dtr: false, rts: false }, (error) => error ? reject(error) : resolve(undefined)));
    // Opening the tty and setting modem lines can each create an auto-reset pulse.
    // Establish the stable observation window after those explicit host actions.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    start = Date.now(); await new Promise((resolve) => setTimeout(resolve, 65000));
  } finally { await new Promise((resolve, reject) => p.close((error) => error ? reject(error) : resolve(undefined))); }
  const stable = lines.filter((line) => line.time >= start);
  const ticks = stable.filter((line) => line.line.startsWith('WICRO_NANO_TICK'));
  const bootAfter = await programmer.session(async (p) => { const bytes = await p.readFlash(30720, 2048); await p.command([0x51]); return bytes; });
  assert.deepEqual(bootAfter, bootBefore);
  const offline = build(['--offline']); assert.deepEqual(new Uint8Array(await readFile(offline.bin)), image);
  const report = { timestamp: new Date().toISOString(), path, baudRate, ...flashed, sha256: createHash('sha256').update(image).digest('hex'), stableWindowMs: 65000,
    startupBanners: lines.filter((line) => line.line === 'WICRO_NANO_READY').length, unexpectedBoots: stable.filter((line) => line.line === 'WICRO_NANO_READY').length,
    ticks: ticks.length, spanMs: ticks.length ? ticks[ticks.length - 1].time - ticks[0].time : 0, bootloaderPreserved: true, offlineIdentical: true };
  await mkdir('.wicro/nano', { recursive: true }); await writeFile('.wicro/nano/acceptance.json', JSON.stringify(report, null, 2)); await writeFile('.wicro/nano/acceptance-serial.log', text);
  console.log(JSON.stringify(report));
  assert.ok(report.startupBanners >= 1); assert.equal(report.unexpectedBoots, 0); assert.ok(report.ticks >= 120 && report.spanMs >= 63000);
});
