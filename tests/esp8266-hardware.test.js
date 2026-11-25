import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { SerialPort } from 'serialport';
import { Esp8266NodeProgrammer } from '../packages/programmers/src/esp8266-node.js';

const enabled = process.env.WICRO_ESP8266_HARDWARE === '1';
test('ESP8266 WASM build, automatic ROM entry, flash/readback and 65-second UART stability', { skip: !enabled, timeout: 150000 }, async () => {
  const expectedMac = process.env.WICRO_ESP8266_MAC;
  assert.ok(expectedMac, 'Explicit WICRO_ESP8266_MAC is required before modifying hardware');
  const path = process.env.WICRO_ESP8266_PORT ?? '/dev/ttyUSB0';
  const project = resolve('examples/esp8266/bare-metal-heartbeat');
  const build = (/** @type {string[]} */ extra = []) => {
    const result = spawnSync(process.execPath, ['packages/wicro/bin/wicro.js', 'build', `--project=${project}`, '--json', ...extra], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const built = build();
  assert.equal(built.adapter, 'shared-wasm-engine');
  const image = new Uint8Array(await readFile(built.bin));
  const flash = await new Esp8266NodeProgrammer({ path, expectedMac }).writeFlash(image);
  assert.equal(flash.readback.verified, true);
  const port = new SerialPort({ path, baudRate: 115200, autoOpen: false });
  let text = '', pending = '';
  /** @type {{text:string,time:number}[]} */
  const lines = [];
  port.on('data', (bytes) => {
    text += bytes.toString(); pending += bytes.toString();
    const parts = pending.split(/\r?\n/); pending = parts.pop() ?? '';
    for (const line of parts) for (const token of line.match(/WICRO_ESP8266_(?:READY|TICK GPIO2=(?:LOW|HIGH))/g) ?? []) lines.push({ text: token, time: Date.now() });
  });
  await new Promise((resolve, reject) => port.open((error) => error ? reject(error) : resolve(undefined)));
  const started = Date.now();
  try {
    /** Always provide both lines: SerialPort.set fills omitted flags with defaults. @param {boolean} rts */
    const set = (rts) => new Promise((resolve, reject) => port.set({ dtr: false, rts }, (error) => error ? reject(error) : resolve(undefined)));
    await set(true); await new Promise((resolve) => setTimeout(resolve, 100)); await set(false);
    await new Promise((resolve) => setTimeout(resolve, 65000));
  } finally { await new Promise((resolve, reject) => port.close((error) => error ? reject(error) : resolve(undefined))); }
  const ticks = lines.filter((line) => line.text.startsWith('WICRO_ESP8266_TICK'));
  const ready = lines.filter((line) => line.text === 'WICRO_ESP8266_READY');
  const gaps = ticks.slice(1).map((line, index) => line.time - ticks[index].time);
  const offline = build(['--offline']);
  assert.deepEqual(new Uint8Array(await readFile(offline.bin)), image);
  const report = { timestamp: new Date().toISOString(), path, ...flash, sha256: createHash('sha256').update(image).digest('hex'), durationMs: Date.now() - started,
    ready: ready.length, ticks: ticks.length, low: ticks.filter((line) => line.text.endsWith('LOW')).length, high: ticks.filter((line) => line.text.endsWith('HIGH')).length,
    observedSpanMs: ticks.length ? ticks[ticks.length - 1].time - ticks[0].time : 0, maximumGapMs: gaps.length ? Math.max(...gaps) : null,
    exception: /exception|wdt reset/i.test(text), offlineIdentical: true };
  await mkdir('.wicro/hardware', { recursive: true });
  await writeFile('.wicro/hardware/esp8266-acceptance.json', JSON.stringify(report, null, 2));
  await writeFile('.wicro/hardware/esp8266-acceptance-serial.log', text);
  console.log(JSON.stringify(report));
  assert.equal(report.ready, 1, 'exactly one application boot banner');
  assert.ok(report.ticks >= 30 && report.observedSpanMs >= 60000, 'continuous real serial execution for at least 60 seconds');
  assert.ok(report.maximumGapMs !== null && report.maximumGapMs < 2000);
  assert.ok(report.low > 0 && report.high > 0);
  assert.equal(report.exception, false);
});
