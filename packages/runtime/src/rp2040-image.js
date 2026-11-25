import { elfToBin } from './elf-utils.js';
/** RP2040 boot ROM non-reflected CRC32, initial 0xffffffff and no final XOR. @param {Uint8Array} bytes */
export const rp2040BootCrc = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte << 24; for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0)) >>> 0; }
  return crc >>> 0;
};
/** @param {Uint8Array} image */
export const validateRp2040Image = (image) => {
  if (!(image instanceof Uint8Array) || image.length < 264 || image.length > 2097152) throw new Error('RP2040-Zero image must fit the 2 MiB flash profile');
  const v = new DataView(image.buffer, image.byteOffset, image.byteLength);
  if (v.getUint32(252, true) !== rp2040BootCrc(image.subarray(0, 252))) throw new Error('RP2040 boot2 CRC mismatch');
  const stack = v.getUint32(256, true), entry = v.getUint32(260, true);
  if (stack <= 0x20000000 || stack > 0x20042000 || stack % 8) throw new Error('RP2040 initial stack is outside SRAM');
  if (!(entry & 1) || entry < 0x10000100 || entry - 1 >= 0x10000000 + image.length) throw new Error('RP2040 reset vector is outside the Thumb firmware image');
  return { valid: true, errors: [], entry, stack };
};
/** @param {Uint8Array} elf */
export const elfToRp2040Bin = async (elf) => {
  const image = await elfToBin(elf);
  if (image.length < 264 || image.length > 2097152) throw new Error('Invalid RP2040 flash image layout');
  new DataView(image.buffer).setUint32(252, rp2040BootCrc(image.subarray(0, 252)), true);
  validateRp2040Image(image); return image;
};
/** @param {Uint8Array} image */
export const rp2040BinToUf2 = (image) => {
  validateRp2040Image(image);
  const count = Math.ceil(image.length / 256), bytes = new Uint8Array(count * 512), v = new DataView(bytes.buffer);
  for (let index = 0; index < count; index++) {
    const at = index * 512;
    for (const [offset, value] of [[0,0x0a324655],[4,0x9e5d5157],[8,0x2000],[12,0x10000000+index*256],[16,256],[20,index],[24,count],[28,0xe48bff56],[508,0x0ab16f30]]) v.setUint32(at+offset,value,true);
    bytes.fill(255, at+32, at+288);bytes.set(image.subarray(index*256,index*256+256),at+32);
  }
  return bytes;
};
/** Validate and decode RP2040 flash UF2, accepting reordered complete blocks.
 * @param {Uint8Array} bytes
 */
export const rp2040Uf2ToBin = (bytes) => {
  if(!bytes.length||bytes.length%512)throw new Error('Invalid RP2040 UF2 size');
  const count=bytes.length/512;
  if(count>8192)throw new Error('RP2040-Zero UF2 exceeds 2 MiB');
  const image=new Uint8Array(count*256),seen=new Set(),v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(let at=0;at<bytes.length;at+=512){
    const index=v.getUint32(at+20,true);
    if(v.getUint32(at,true)!==0x0a324655||v.getUint32(at+4,true)!==0x9e5d5157||v.getUint32(at+508,true)!==0x0ab16f30||v.getUint32(at+8,true)!==0x2000||v.getUint32(at+28,true)!==0xe48bff56)throw new Error('Invalid RP2040 UF2 magic, flags or family');
    if(index>=count||seen.has(index)||v.getUint32(at+24,true)!==count||v.getUint32(at+16,true)!==256||v.getUint32(at+12,true)!==0x10000000+index*256)throw new Error('Invalid or duplicate RP2040 UF2 block/address');
    seen.add(index);image.set(bytes.subarray(at+32,at+288),index*256);
  }
  validateRp2040Image(image);return image;
};
