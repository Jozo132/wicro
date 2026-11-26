import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dfuseAddressCommand, parseDfuStatus, parseDfuFunctionalDescriptor, parseDfuseMemory, planDfuWrite } from '../src/dfu.js';
import { validateCortexMImage, STM32F401RC_CDC_DFU_PROFILE as profile, STM32_DFU_PROFILES } from '../src/cdc-dfu-profile.js';
import { CDC_DFU_MAGIC, CDC_DFU_TRIGGER_STEPS } from '../src/cdc-dfu-trigger.js';

const geometry = '@Internal Flash  /0x08000000/04*016Kg,01*064Kg,01*128Kg';
test('STM32 DFU profiles cover matching MCU flash and RAM bounds', () => {
  assert.equal(STM32_DFU_PROFILES['STM32F103C8'].capacity, 65536);
  assert.equal(STM32_DFU_PROFILES['STM32F103CB'].capacity, 131072);
  assert.equal(STM32_DFU_PROFILES['STM32F411CE'].capacity, 524288);
  assert.equal(STM32_DFU_PROFILES['STM32F401RE'].capacity, 524288);
  assert.equal(STM32_DFU_PROFILES['STM32H723VG'].capacity, 1048576);
  for (const mcuProfile of Object.values(STM32_DFU_PROFILES)) {
    assert.equal(mcuProfile.address, 0x08000000);
    assert.equal(mcuProfile.protocol, 'dfuse');
  }
});

test('STM32 DFU fallback sectors cover firmware when the device advertises no geometry', () => {
  const fallback = STM32_DFU_PROFILES['STM32F401RC'].fallbackSectors;
  assert.ok(Array.isArray(fallback));
  const plan = planDfuWrite([{ address: profile.address, data: new Uint8Array(27672) }], profile, /** @type {any} */ (fallback), true);
  assert.equal(plan.bytes, 27672);
});

test('F401RC advertised geometry produces only the pages intersecting the image', () => {
  const sectors = parseDfuseMemory(geometry);
  assert.deepEqual(sectors.map((page) => page.size), [16384, 16384, 16384, 16384, 65536, 131072]);
  const plan = planDfuWrite([{ address: profile.address, data: new Uint8Array(27672) }], profile, sectors, true);
  assert.deepEqual(plan.erase.map((page) => page.address), [0x08000000, 0x08004000]);
  assert.equal(plan.bytes, 27672);
});
test('DFU preflight rejects partial-page boundaries, gaps, protected pages and overlapping images', () => {
  const sectors = parseDfuseMemory(geometry);
  const file = { address: profile.address, data: new Uint8Array(8) };
  assert.throws(() => planDfuWrite([file], { ...profile, capacity: 8 }, sectors, true), /boundary/);
  assert.throws(() => planDfuWrite([file, file], profile, sectors, true), /overlapping/);
  assert.throws(() => planDfuWrite([file], profile, [], true), /covered/);
  assert.throws(() => planDfuWrite([file], profile, [{ ...sectors[0], writable: false }], true), /protected/);
  assert.throws(() => planDfuWrite([{ ...file, address: 0x1fff7800 }], profile, sectors, true), /outside/);
  assert.throws(() => parseDfuseMemory('@Flash /0xffffff00/02*001Kg'), /address space/);
  assert.throws(() => parseDfuseMemory('@Flash /0x08000000/unknown'), /geometry/);
});
test('DfuSe commands and status use the exact USB wire encoding', () => {
  assert.deepEqual([...dfuseAddressCommand(0x21, 0x08004000)], [0x21, 0, 0x40, 0, 8]);
  assert.throws(() => dfuseAddressCommand(0x92, 0), /Invalid/);
  assert.deepEqual(parseDfuStatus(Uint8Array.of(0, 0x56, 0x34, 0x12, 5, 0)), { status: 0, pollTimeoutMs: 0x123456, state: 5, stringIndex: 0 });
  assert.throws(() => parseDfuStatus(new Uint8Array(5)), /six bytes/);
});
test('STM32 shared functional descriptor can follow the final alternate', () => {
  const bytes = Uint8Array.from([9, 4, 0, 0, 0, 0xfe, 1, 2, 0, 9, 4, 0, 3, 0, 0xfe, 1, 2, 0, 9, 0x21, 11, 255, 0, 0, 8, 0x1a, 1]);
  assert.deepEqual(parseDfuFunctionalDescriptor(bytes, 0, 0), { attributes: 11, transferSize: 2048, version: 282 });
  assert.throws(() => parseDfuFunctionalDescriptor(bytes, 1, 0), /not found/);
  assert.throws(() => parseDfuFunctionalDescriptor(Uint8Array.of(0, 4), 0, 0), /Malformed/);
});
test('Cortex-M image validation refuses incompatible vector tables before flash', () => {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x20010000, true); view.setUint32(4, 0x08000009, true);
  assert.equal(validateCortexMImage(bytes, profile).stack, 0x20010000);
  view.setUint32(4, 0x08000008, true);
  assert.throws(() => validateCortexMImage(bytes, profile), /Thumb/);
  view.setUint32(0, 0x20020000, true);
  assert.throws(() => validateCortexMImage(bytes, profile), /RAM/);
});
test('CDC trigger matches the published 1.1.2 DTR sequence and magic', () => {
  assert.equal(new TextDecoder().decode(CDC_DFU_MAGIC), 'DFU!');
  assert.deepEqual(CDC_DFU_TRIGGER_STEPS.map((step) => step.dtr), [true, false, true, false, true, false, false]);
  assert.equal(CDC_DFU_TRIGGER_STEPS.reduce((sum, step) => sum + step.delayMs, 0), 300);
});
