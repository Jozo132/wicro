import assert from 'node:assert/strict';
import test from 'node:test';
import { ProgrammerProtocolRegistry, programmerProtocols } from '../src/index.js';

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

test('custom programmer protocol factories are public', async () => {
  const registry = new ProgrammerProtocolRegistry();
  registry.register('demo', async () => ({
    async probe() { return { ok: true, protocol: 'demo' }; },
    async writeFlash() { return { ok: true }; }
  }));

  const protocol = await registry.create('demo', { transport: {} });
  assert.deepEqual(await protocol.probe({ transport: {} }), { ok: true, protocol: 'demo' });
});
