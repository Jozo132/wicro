import test from 'node:test';
import assert from 'node:assert/strict';
import { stlinkMemoryPacket, parseStLinkSerialDescriptor, validateStm32F103Image } from '../src/stlink.js';

test('ST-Link memory packet wire layout and alignment/boundary guards', () => {
  assert.deepEqual([...stlinkMemoryPacket(0x48, 0x08000200, 2)], [0xf2, 0x48, 0, 2, 0, 8, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  for (const [command, address, length] of [[0x48, 0x08000001, 2], [7, 0x20000002, 4], [7, 0x200003fc, 8], [8, 0x20000000, 1028], [7, 0xffffffff, 4], [7, -4, 4]]) assert.throws(() => stlinkMemoryPacket(command, address, length));
});

test('ST-Link serial decoding retains embedded NUL code units instead of truncating identity', () => {
  const words = [0x16, 0x18, 0x0c, 0, 0x2c, 0x13, 0x57, 0x37, 0x33, 0x4d, 0x4e, 0];
  const binary = new Uint8Array(26); binary.set([26, 3]);
  words.forEach((word, index) => new DataView(binary.buffer).setUint16(2 + 2 * index, word, true));
  assert.equal(parseStLinkSerialDescriptor(binary), '16180c002c135737334d4e00');
  const serial = '066DFF373841423043110931', ascii = new Uint8Array(50); ascii.set([50, 3]);
  [...serial].forEach((char, index) => new DataView(ascii.buffer).setUint16(2 + 2 * index, char.charCodeAt(0), true));
  assert.equal(parseStLinkSerialDescriptor(ascii), serial.toLowerCase());
  assert.throws(() => parseStLinkSerialDescriptor(ascii.subarray(0, 48)), /Malformed/);
});

test('F103 image checks enforce C8 capacity, SRAM bounds and Thumb reset', () => {
  const image = new Uint8Array(128), view = new DataView(image.buffer);
  view.setUint32(0, 0x20005000, true); view.setUint32(4, 0x08000041, true);
  assert.equal(validateStm32F103Image(image, 65536).stack, 0x20005000);
  assert.throws(() => validateStm32F103Image(new Uint8Array(65540), 65536), /profile/);
  assert.throws(() => validateStm32F103Image(image, 262144), /profile/);
  view.setUint32(0, 0x20005008, true); assert.throws(() => validateStm32F103Image(image), /stack/);
  view.setUint32(0, 0x20005000, true); view.setUint32(4, 0x08000040, true); assert.throws(() => validateStm32F103Image(image), /Thumb/);
  view.setUint32(4, 0x08010001, true); assert.throws(() => validateStm32F103Image(image), /Thumb/);
});
