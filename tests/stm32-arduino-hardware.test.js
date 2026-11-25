import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { SerialPort } from 'serialport';

test('genuine shared-engine STM32 Arduino upload/readback and 65-second native USB CDC execution', { skip: process.env.WICRO_STM32_ARDUINO_HARDWARE !== '1', timeout: 600000 }, async () => {
  const board = process.env.WICRO_STM32_BOARD, serial = process.env.WICRO_STM32_CDC_SERIAL;
  assert.ok(board && ['stm32f103c8', 'stm32f401rc'].includes(board) && serial, 'Select a supported board and its explicit CDC USB serial');
  const project = `examples/${board}/arduino-usb-heartbeat`;
  const cli = (/** @type {string[]} */ args) => {
    const result = spawnSync(process.execPath, ['packages/wicro/bin/wicro.js', ...args, '--json'], { encoding: 'utf8', timeout: 450000 });
    assert.equal(result.status, 0, result.stdout + result.stderr); return JSON.parse(result.stdout);
  };
  const built = cli(['build', `--project=${project}`]);
  const image = new Uint8Array(await readFile(built.bin));
  const selection = board === 'stm32f401rc' ? [`--serial=${serial}`] : [`--serial=${process.env.WICRO_F103_PROBE}`, `--uid=${process.env.WICRO_F103_UID}`];
  const cdcOnly = process.env.WICRO_STM32_CDC_ONLY === '1';
  if (board === 'stm32f103c8' && !cdcOnly) assert.ok(process.env.WICRO_F103_PROBE && process.env.WICRO_F103_UID, 'Explicit F103 probe and UID are required before programming');
  const flashed = cdcOnly ? { command: 'observe-existing', readback: { verified: false } } : cli(['upload', `--project=${project}`, ...selection]);
  if (!cdcOnly) assert.equal(flashed.readback.verified, true);
  const deadline = Date.now() + 10000;
  /** @type {string|undefined} */ let path;
  while (Date.now() < deadline) {
    /** @type {Awaited<ReturnType<typeof SerialPort.list>>} */
    const ports = (await SerialPort.list()).filter((port) => port.vendorId === '0483' && port.productId === '5740' && port.serialNumber === serial);
    assert.ok(ports.length <= 1, 'CDC serial must select one device');
    if (ports[0]) { path = ports[0].path; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(path, 'Matching STM32 Arduino CDC must enumerate');
  const port = new SerialPort({ path, baudRate: 115200, autoOpen: false });
  let pending = '', text = '', disconnected = false, error = '';
  /** @type {{counter:number,time:number}[]} */ const ticks = [];
  port.on('data', (bytes) => {
    text += bytes.toString(); pending += bytes.toString(); const lines = pending.split(/\r?\n/); pending = lines.pop() ?? '';
    for (const line of lines) { const match = line.match(/^WICRO_STM32_ARDUINO_TICK (\d+)$/); if (match) ticks.push({ counter: Number(match[1]), time: Date.now() }); }
  });
  port.on('error', (event) => { error = event.message; }); port.on('close', () => { disconnected = true; });
  await new Promise((resolve, reject) => port.open((event) => event ? reject(event) : resolve(undefined)));
  const started = Date.now(); await new Promise((resolve) => setTimeout(resolve, 65000));
  const earlyDisconnect = disconnected, observationMs = Date.now() - started;
  if (port.isOpen) await new Promise((resolve, reject) => port.close((event) => event ? reject(event) : resolve(undefined)));
  const offline = cli(['build', `--project=${project}`, '--offline']);
  assert.deepEqual(new Uint8Array(await readFile(offline.bin)), image);
  const report = { timestamp: new Date().toISOString(), board, serial, path, flashed, sha256: createHash('sha256').update(image).digest('hex'), windowMs: observationMs, ticks: ticks.length, spanMs: ticks.length ? ticks[ticks.length - 1].time - ticks[0].time : 0, first: ticks[0]?.counter, last: ticks.at(-1)?.counter, earlyDisconnect, error, offlineIdentical: true };
  await mkdir('.wicro/stm32-sdk', { recursive: true });
  await writeFile(`.wicro/stm32-sdk/${board}-arduino-acceptance.json`, JSON.stringify(report, null, 2));
  await writeFile(`.wicro/stm32-sdk/${board}-arduino-serial.log`, text); console.log(JSON.stringify(report));
  assert.equal(error, ''); assert.equal(earlyDisconnect, false); assert.ok(ticks.length >= 60 && report.spanMs >= 60000);
  for (let index = 1; index < ticks.length; index++) assert.equal(ticks[index].counter, ticks[index - 1].counter + 1, 'Arduino counter must not skip or reset');
});
