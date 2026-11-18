import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeSerialHost } from '../src/index.js';

test('discovers serial devices through SerialPort', async () => {
  const host = new NodeSerialHost();
  const devices = await host.discover();

  assert.ok(Array.isArray(devices));
  assert.ok(devices.every((device) => typeof device.path === 'string'));
});

test('identifies the connected Espressif USB JTAG serial device', async () => {
  const host = new NodeSerialHost();
  const devices = await host.discover();
  const esp = devices.find((device) => device.vendorId === 0x303a);

  if (esp) {
    assert.equal(esp.productId, 0x1001);
  }
});
