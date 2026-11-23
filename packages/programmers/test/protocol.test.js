import assert from 'node:assert/strict';
import test from 'node:test';
import { ProgrammerProtocolRegistry, programmerProtocols } from '../src/index.js';
import { NodeEspSerialTransport, SlipDecoder, ESP32_C3_USB_JTAG_RESET_STEPS } from '../src/nodeEspSerial.js';
import { validateEsp32FlashImages, validateEsp32ApplicationPartition } from '../src/index.js';

test('simulated programmer protocol validates and reports flash writes', async () => {
  const protocol = await programmerProtocols.create('simulated', { transport: {} });
  const probe = /** @type {{ok:boolean}} */ (await protocol.probe({ transport: {} }));
  assert.equal(probe.ok, true);

  const result = /** @type {{ok:boolean,bytes:number}} */ (await protocol.writeFlash(
    { transport: {} },
    [{ address: 0x08000000, data: new Uint8Array([1, 2, 3]) }]
  ));
  assert.equal(result.ok, true);
  assert.equal(result.bytes, 3);
});

test('ESP32 application-only flash preserves bootloader and partition table', () => {
  assert.deepEqual(validateEsp32FlashImages([
    { address: 0x10000, data: new Uint8Array([0xe9, 1, 2, 3]) }
  ]), { ok: true, addresses: [0x10000], bootloaderBytes: 0, partitionBytes: 0, applicationBytes: 4 });
});

test('ESP32 flash image preflight rejects incomplete images', () => {
  assert.throws(() => validateEsp32FlashImages([{ address: 0x0, data: new Uint8Array([0xe9]) }]), /partition/);
  assert.deepEqual(validateEsp32FlashImages([
    { address: 0x0, data: new Uint8Array([0xe9, 1]) },
    { address: 0x8000, data: new Uint8Array([0xaa, 0x50]) },
    { address: 0x10000, data: new Uint8Array([0xe9, 2]) }
  ]), { ok: true, addresses: [0, 0x8000, 0x10000], bootloaderBytes: 2, partitionBytes: 2, applicationBytes: 2 });
});

test('SLIP decoder preserves fragmented packets, escapes and packet boundaries', () => {
  const decoder = new SlipDecoder();
  decoder.feed(new Uint8Array([0xc0, 0x01, 0x02]));
  decoder.feed(new Uint8Array([0xdb, 0xdc, 0x03, 0xc0]));
  assert.deepEqual(decoder.shiftPacket(), new Uint8Array([0x01, 0x02, 0xc0, 0x03]));

  decoder.feed(new Uint8Array([0xc0, 0x41, 0xc0, 0xc0, 0x42, 0xdb, 0xdd, 0xc0]));
  assert.deepEqual(decoder.shiftPacket(), new Uint8Array([0x41]));
  assert.deepEqual(decoder.shiftPacket(), new Uint8Array([0x42, 0xdb]));
});

test('ESP32-C3 USB-JTAG reset uses the proven CDC line-state sequence', () => {
  assert.deepEqual(ESP32_C3_USB_JTAG_RESET_STEPS, [
    { dtr: false, rts: false, delayAfterMs: 100 },
    { dtr: true, rts: false, delayAfterMs: 100 },
    { dtr: false, rts: true, delayAfterMs: 100 },
    { dtr: false, rts: false, delayAfterMs: 50 }
  ]);
});

test('SLIP decoder rejects malformed escape and bounded queue overflow', () => {
  const malformed = new SlipDecoder();
  malformed.feed(new Uint8Array([0xc0, 0xdb, 0x00, 0xc0]));
  assert.throws(() => malformed.shiftPacket(), /Invalid SLIP escape/);

  const bounded = new SlipDecoder();
  bounded.feed(new Uint8Array([0xc0, 0xc0]));
  for (let index = 0; index < 17; index++) bounded.feed(new Uint8Array([0x01, 0xc0]));
  assert.throws(() => bounded.shiftPacket(), /queue exceeded|Invalid SLIP escape|packet exceeded/i);
});

test('native USB VCP reset emits DTR and RTS boot signals', async () => {
  /** @type {Record<string,boolean>[]} */
  const signals = [];
  const transport = new NodeEspSerialTransport({ path: '/dev/ttyACM0', baudRate: 115200, vid: 0x303a, pid: 0x1001 });
  transport.port = /** @type {any} */ ({
    isOpen: true,
    set: (/** @type {Record<string,boolean>} */ value, /** @type {(error?:Error|null)=>void} */ callback) => { signals.push(value); callback(null); },
    off: () => {},
    close: (/** @type {(error?:Error|null)=>void} */ callback) => callback(null)
  });

  await transport.resetForDownload();
  assert.ok(signals.some((signal) => signal.dtr === true));
  assert.ok(signals.some((signal) => signal.rts === true));
  await transport.disconnect();
  assert.equal(transport.port, undefined);
});

test('ESP32 application partition rejects oversized firmware', () => {
  assert.deepEqual(validateEsp32ApplicationPartition(100, 0x10000, 0x180000), { ok: true, partitionOffset: 0x10000, partitionCapacity: 0x180000, applicationSize: 100 });
  assert.throws(() => validateEsp32ApplicationPartition(0x180001, 0x10000, 0x180000), /exceeds partition capacity/);
});

test('custom programmer protocol factories are public', async () => {
  const registry = new ProgrammerProtocolRegistry();
  registry.register('demo', async () => ({
    async probe() { return { ok: true, protocol: 'demo' }; },
    async writeFlash() { return { ok: true }; }
  }));

  const protocol = await registry.create('demo', { transport: {} });
  assert.deepEqual(await protocol.probe({ transport: {} }), { ok: true, protocol: 'demo' });
});
