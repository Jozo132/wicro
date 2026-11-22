import assert from 'node:assert/strict';
import test from 'node:test';
import { ProgrammerProtocolRegistry, programmerProtocols } from '../src/index.js';
import { NodeEspSerialTransport } from '../src/nodeEspSerial.js';
import { validateEsp32FlashImages } from '../src/index.js';

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

test('ESP32 flash image preflight rejects incomplete images', () => {
  assert.throws(() => validateEsp32FlashImages([{ address: 0x0, data: new Uint8Array([0xe9]) }]), /partition/);
  assert.deepEqual(validateEsp32FlashImages([
    { address: 0x0, data: new Uint8Array([0xe9, 1]) },
    { address: 0x8000, data: new Uint8Array([0xaa, 0x50]) },
    { address: 0x10000, data: new Uint8Array([0xe9, 2]) }
  ]), { ok: true, addresses: [0, 0x8000, 0x10000], bootloaderBytes: 2, partitionBytes: 2, applicationBytes: 2 });
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

test('custom programmer protocol factories are public', async () => {
  const registry = new ProgrammerProtocolRegistry();
  registry.register('demo', async () => ({
    async probe() { return { ok: true, protocol: 'demo' }; },
    async writeFlash() { return { ok: true }; }
  }));

  const protocol = await registry.create('demo', { transport: {} });
  assert.deepEqual(await protocol.probe({ transport: {} }), { ok: true, protocol: 'demo' });
});
