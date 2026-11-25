import test from 'node:test';
import assert from 'node:assert/strict';
import { picobootPacket } from '../src/picoboot.js';
import { rp2040BootCrc, validateRp2040Image, rp2040BinToUf2, rp2040Uf2ToBin } from '../../runtime/src/rp2040-image.js';

test('PICOBOOT packet uses the official 32-byte header and explicit lengths', () => {
  const packet=picobootPacket(0x84,7,Uint8Array.of(1,2,3,4,5,6,7,8),4096),v=new DataView(packet.buffer);
  assert.equal(packet.length,32);assert.equal(v.getUint32(0,true),0x431fd10b);assert.equal(v.getUint32(4,true),7);assert.equal(packet[8],0x84);assert.equal(packet[9],8);assert.equal(v.getUint32(12,true),4096);
  assert.deepEqual([...packet.subarray(16,24)],[1,2,3,4,5,6,7,8]);
  assert.throws(()=>picobootPacket(0,0,new Uint8Array(17),0));assert.throws(()=>picobootPacket(0,0,new Uint8Array(),0x100000000));
});
test('RP2040 boot CRC, vectors and UF2 validation reject corrupt/cross-target artifacts', () => {
  assert.equal(rp2040BootCrc(new TextEncoder().encode('123456789')),0x0376e6e7);
  const image=new Uint8Array(512),v=new DataView(image.buffer);v.setUint32(252,rp2040BootCrc(image.subarray(0,252)),true);v.setUint32(256,0x20042000,true);v.setUint32(260,0x10000109,true);
  assert.equal(validateRp2040Image(image).valid,true);const uf2=rp2040BinToUf2(image);assert.deepEqual(rp2040Uf2ToBin(uf2),image);
  const shuffled=new Uint8Array(1024);shuffled.set(uf2.subarray(512),0);shuffled.set(uf2.subarray(0,512),512);assert.deepEqual(rp2040Uf2ToBin(shuffled),image);
  const bad=image.slice();bad[0]^=1;assert.throws(()=>validateRp2040Image(bad),/CRC/);
  const other=uf2.slice();new DataView(other.buffer).setUint32(28,0,true);assert.throws(()=>rp2040Uf2ToBin(other),/family/);
  const duplicate=uf2.slice();duplicate.set(duplicate.subarray(0,512),512);assert.throws(()=>rp2040Uf2ToBin(duplicate),/duplicate/);
});
