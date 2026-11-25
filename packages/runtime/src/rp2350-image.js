import { elfToFlatBin } from './elf-utils.js';

/** Validate the deliberately small, unsigned single-block RP2350 image profile.
 * Other PICOBIN layouts must have their own parser before being accepted.
 * @param {Uint8Array} image
 */
export const validateRp2350Image = (image) => {
  if (!(image instanceof Uint8Array) || image.length < 40 || image.length > 2097152) throw new Error('RP2350 image must fit the conservative 2 MiB profile');
  const v = new DataView(image.buffer, image.byteOffset, image.byteLength);
  if (v.getUint32(8, true) !== 0xffffded3) throw new Error('Missing RP2350 image definition');
  const type = v.getUint32(12, true), riscv = type === 0x11010142;
  if (!riscv && type !== 0x10210142) throw new Error('Unsupported RP2350 image type/security');
  const end = riscv ? 28 : 16;
  if (v.getUint32(end, true) !== (riscv ? 0x4ff : 0x1ff) || v.getUint32(end + 4, true) !== 0 || v.getUint32(end + 8, true) !== 0xab123579) throw new Error('Invalid RP2350 single-block image definition');
  if (riscv && v.getUint32(16, true) !== 0x344) throw new Error('Missing RISC-V entry point');
  const stack = v.getUint32(riscv ? 24 : 0, true), entry = v.getUint32(riscv ? 20 : 4, true);
  if (stack <= 0x20000000 || stack > 0x20082000 || stack % 8) throw new Error('RP2350 stack is outside SRAM');
  const address = riscv ? entry : entry - 1;
  if ((riscv ? entry % 2 : !(entry & 1)) || address < 0x10000000 + end + 12 || address >= 0x10000000 + image.length) throw new Error('RP2350 entry point is outside its architecture image');
  return { valid: true, errors: [], architecture: riscv ? 'riscv32' : 'armv8m-mainline', entry, stack };
};
/** @param {Uint8Array} elf */
export const elfToRp2350Bin = async (elf) => {
  const image = await elfToFlatBin(elf), info = validateRp2350Image(image);
  const machine = new DataView(elf.buffer, elf.byteOffset, elf.byteLength).getUint16(18, true);
  if (machine !== (info.architecture === 'riscv32' ? 243 : 40)) throw new Error('RP2350 ELF architecture does not match its boot metadata');
  return image;
};
/** @param {Uint8Array} image */
export const rp2350BinToUf2 = (image) => {
  const info = validateRp2350Image(image), count = Math.ceil(image.length / 256);
  const bytes = new Uint8Array(count * 512), v = new DataView(bytes.buffer);
  for (let index = 0; index < count; index++) {
    const at = index * 512;
    for (const [offset, value] of [[0,0x0a324655],[4,0x9e5d5157],[8,0x2000],[12,0x10000000+index*256],[16,256],[20,index],[24,count],[28,info.architecture === 'riscv32' ? 0xe48bff5a : 0xe48bff59],[508,0x0ab16f30]]) v.setUint32(at+offset,value,true);
    bytes.fill(255, at+32, at+288); bytes.set(image.subarray(index*256,index*256+256),at+32);
  }
  return bytes;
};
/** @param {Uint8Array} bytes */
export const rp2350Uf2ToBin = (bytes) => {
  if (!bytes.length || bytes.length % 512 || bytes.length > 8192 * 512) throw new Error('Invalid RP2350 UF2 size');
  const count=bytes.length/512, image=new Uint8Array(count*256), seen=new Set(), v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const family=v.getUint32(28,true);
  if (![0xe48bff59,0xe48bff5a].includes(family)) throw new Error('Invalid RP2350 UF2 family');
  for(let at=0;at<bytes.length;at+=512){
    const index=v.getUint32(at+20,true);
    if(v.getUint32(at,true)!==0x0a324655||v.getUint32(at+4,true)!==0x9e5d5157||v.getUint32(at+508,true)!==0x0ab16f30||v.getUint32(at+8,true)!==0x2000||v.getUint32(at+28,true)!==family||index>=count||seen.has(index)||v.getUint32(at+24,true)!==count||v.getUint32(at+16,true)!==256||v.getUint32(at+12,true)!==0x10000000+index*256)throw new Error('Invalid RP2350 UF2 block/address');
    seen.add(index);image.set(bytes.subarray(at+32,at+288),index*256);
  }
  const info=validateRp2350Image(image);
  if ((info.architecture==='riscv32') !== (family===0xe48bff5a)) throw new Error('RP2350 UF2 architecture mismatch');
  return image;
};
