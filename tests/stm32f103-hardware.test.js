import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomInt } from 'node:crypto';
import { StLinkNodeProgrammer } from '../packages/programmers/src/stlink-node.js';
import { sampleStm32F103Runtime } from '../packages/programmers/src/stlink.js';

test('STM32F103C8 WASM CLI/ST-Link flash, preservation and 65-second live SWD challenges', { skip: process.env.WICRO_F103_HARDWARE !== '1', timeout: 150000 }, async () => {
  const serialNumber = process.env.WICRO_F103_PROBE, expectedUid = process.env.WICRO_F103_UID;
  assert.ok(serialNumber && expectedUid, 'Explicit probe serial and target UID are required before writing');
  const project = 'examples/stm32f103c8/swd-heartbeat';
  const cli = (/** @type {string[]} */ args) => {
    const result = spawnSync(process.execPath, ['packages/wicro/bin/wicro.js', ...args, '--json'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stdout + result.stderr); return JSON.parse(result.stdout);
  };
  const built = cli(['build', `--project=${project}`]), image = new Uint8Array(await readFile(built.bin));
  const programmer = new StLinkNodeProgrammer({ serialNumber, expectedUid });
  const before = await programmer.session(async (probe) => {
    const target = await probe.identify(); assert.equal(target.uid, expectedUid); assert.equal(target.capacity, 65536);
    return { flash: await probe.readMemory(0x08000000, 65536), options: await probe.readMemory(0x1ffff800, 16) };
  });
  const flashed = cli(['upload', `--project=${project}`, `--serial=${serialNumber}`, `--uid=${expectedUid}`]);
  assert.equal(flashed.readback.verified, true);
  /** @type {Awaited<ReturnType<typeof sampleStm32F103Runtime>>[]} */
  const samples = [];
  const gpio = new Set();
  let stableWindowMs = 0;
  const after = await programmer.session(async (probe) => {
    const start = Date.now();
    do {
      assert.equal((await probe.read32(0xe000edf0)) & 0x20000, 0, 'CPU must stay running');
      const sample = await sampleStm32F103Runtime(probe, randomInt(1, 0x100000000));
      const previous = samples.at(-1);
      if (previous) { assert.equal(sample.sequence, previous.sequence + 1); assert.ok(sample.milliseconds > previous.milliseconds); assert.ok(sample.heartbeat >= previous.heartbeat); }
      samples.push(sample); gpio.add((await probe.read32(0x40010c0c)) & (1 << 2));
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() - start < 65000);
    stableWindowMs = Date.now() - start;
    const flash = await probe.readMemory(0x08000000, 65536), options = await probe.readMemory(0x1ffff800, 16);
    assert.ok((await probe.read32(0x40022010)) & 0x80, 'Flash must be locked after programming');
    await probe.resetAndRun();
    const restarted = await sampleStm32F103Runtime(probe, randomInt(1, 0x100000000));
    return { flash, options, restarted };
  });
  assert.deepEqual(after.flash.subarray(flashed.eraseLength), before.flash.subarray(flashed.eraseLength));
  assert.deepEqual(after.options, before.options);
  assert.equal(after.restarted.sequence, 1);
  assert.ok(samples.length >= 120);
  const last = samples.at(-1); assert.ok(last);
  assert.ok(last.milliseconds - samples[0].milliseconds >= 63000);
  assert.ok(last.heartbeat - samples[0].heartbeat >= 126);
  assert.deepEqual([...gpio].sort(), [0, 4]);
  const offline = cli(['build', `--project=${project}`, '--offline']);
  assert.deepEqual(new Uint8Array(await readFile(offline.bin)), image);
  const report = { timestamp: new Date().toISOString(), flashed, sha256: createHash('sha256').update(image).digest('hex'), samples: samples.length, stableWindowMs, first: samples[0], last, restarted: after.restarted, gpioOutputRegisterStates: [...gpio], untouchedFlashPreserved: true, optionBytesPreserved: true, offlineIdentical: true };
  await mkdir('.wicro/stm32f103', { recursive: true }); await writeFile('.wicro/stm32f103/acceptance.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
});
