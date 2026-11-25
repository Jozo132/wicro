import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomInt } from 'node:crypto';
import { Rp2040NodeProgrammer } from '../packages/programmers/src/rp2040-node.js';
import { sampleRp2040Runtime } from '../packages/programmers/src/picoboot.js';

test('RP2040-Zero WASM firmware, PICOBOOT readback, 65-second USB challenges and runtime-to-ROM re-upload', { skip: process.env.WICRO_RP2040_HARDWARE !== '1', timeout: 150000 }, async () => {
  const serialNumber = process.env.WICRO_RP2040_SERIAL;
  assert.ok(serialNumber, 'Explicit WICRO_RP2040_SERIAL is required before flashing');
  const project = 'examples/rp2040-zero/usb-heartbeat';
  const build = (/** @type {string[]} */ flags = []) => {
    const result = spawnSync(process.execPath, ['packages/wicro/bin/wicro.js', 'build', `--project=${project}`, '--json', ...flags], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stdout + result.stderr); return JSON.parse(result.stdout);
  };
  const built = build(), image = new Uint8Array(await readFile(built.bin));
  const programmer = new Rp2040NodeProgrammer({ serialNumber });
  // Exercise the public CLI, including its board dispatch and explicit ROM identity.
  const upload = spawnSync(process.execPath, ['packages/wicro/bin/wicro.js', 'upload', `--project=${project}`, `--serial=${serialNumber}`, '--json'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(upload.status, 0, upload.stdout + upload.stderr);
  const flashed = JSON.parse(upload.stdout);
  const waitRuntime = async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const device = await programmer.findRuntime();
      if (device) return device;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('RP2040 runtime did not enumerate');
  };
  const device = await waitRuntime();
  await device.open(); await device.claimInterface(0);
  /** @type {Awaited<ReturnType<typeof sampleRp2040Runtime>>[]} */
  const samples = [];
  const start = Date.now();
  try {
    do {
      const sample = await sampleRp2040Runtime(device, randomInt(0x100000000));
      const previous = samples.at(-1);
      if (previous) {
        assert.equal(sample.sequence, previous.sequence + 1, 'Unexpected firmware restart or lost response');
        assert.ok(sample.microseconds > previous.microseconds, 'Hardware timer must advance');
        assert.ok(sample.heartbeat >= previous.heartbeat, 'Heartbeat must not reset');
      }
      samples.push(sample);
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() - start < 65000);
  } finally { await device.close(); }
  assert.ok(samples.length >= 120);
  const last = samples.at(-1);
  assert.ok(last);
  assert.ok(last.heartbeat - samples[0].heartbeat >= 63);
  // This second upload must use the running firmware's actual vendor ROM request.
  const reflashed = await programmer.writeFlash(image);
  const restarted = await waitRuntime(); await restarted.open(); await restarted.claimInterface(0);
  let after;
  try { after = await sampleRp2040Runtime(restarted, randomInt(0x100000000)); }
  finally { await restarted.close(); }
  assert.equal(after.sequence, 1);
  const offline = build(['--offline']); assert.deepEqual(new Uint8Array(await readFile(offline.bin)), image);
  const report = { timestamp: new Date().toISOString(), serialNumber, flashed, reflashed, sha256: createHash('sha256').update(image).digest('hex'), samples: samples.length, stableWindowMs: Date.now() - start, first: samples[0], last: samples.at(-1), restarted: after, offlineIdentical: true };
  await mkdir('.wicro/rp2040', { recursive: true });
  await writeFile('.wicro/rp2040/acceptance.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
});
