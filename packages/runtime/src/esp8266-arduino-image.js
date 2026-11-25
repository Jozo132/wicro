import { rp2040BootCrc } from './rp2040-image.js';

/** @param {Uint8Array} elf */
const sections = (elf) => {
  if (elf.length < 52) throw new Error('Truncated ESP8266 ELF');
  const v = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  if (v.getUint32(0,true)!==0x464c457f || v.getUint16(18,true)!==94 || elf[4]!==1 || elf[5]!==1) throw new Error('Expected Xtensa ELF32');
  const base=v.getUint32(32,true), size=v.getUint16(46,true), count=v.getUint16(48,true), strings=v.getUint16(50,true);
  if(size<40||!count||strings>=count||base+size*count>elf.length)throw new Error('Invalid ELF section table');
  const names=v.getUint32(base+strings*size+16,true);
  /** @type {Map<string,{address:number,data:Uint8Array}>} */const result=new Map();
  for(let i=0;i<count;i++){
    const at=base+i*size, offset=v.getUint32(at+16,true), length=v.getUint32(at+20,true);if(v.getUint32(at+4,true)===8||!length)continue;
    let n=names+v.getUint32(at,true),end=n;while(end<elf.length&&elf[end])end++;
    if(end===elf.length||offset+length>elf.length)throw new Error('Truncated ELF section');
    const name=new TextDecoder().decode(elf.subarray(n,end));result.set(name,{address:v.getUint32(at+12,true),data:elf.subarray(offset,offset+length)});
  }
  return {entry:v.getUint32(24,true),sections:result};
};
/** @param {Uint8Array} elf @param {string[]} names */
const romImage = (elf,names) => {
  const parsed=sections(elf), segments=names.map((name)=>parsed.sections.get(name)??{address:0,data:new Uint8Array()});
  const length=8+segments.reduce((sum,segment)=>sum+8+segment.data.length,0), bytes=new Uint8Array(Math.floor(length/16)*16+16),v=new DataView(bytes.buffer);
  bytes.set([0xe9,segments.length,2,0x40]);v.setUint32(4,parsed.entry,true);let offset=8,checksum=0xef;
  for(const segment of segments){v.setUint32(offset,segment.address,true);v.setUint32(offset+4,segment.data.length,true);bytes.set(segment.data,offset+8);offset+=8+segment.data.length;for(const byte of segment.data)checksum^=byte;}
  bytes[bytes.length-1]=checksum;return bytes;
};
/** Genuine Arduino ESP8266 eboot + application image, including eboot's CRC.
 * @param {Uint8Array} elf @param {Uint8Array} eboot
 */
export const elfToEsp8266ArduinoBin = (elf,eboot) => {
  const boot=romImage(eboot,['.text','.rodata']), app=romImage(elf,['.irom0.text','.text','.text1','.data','.rodata']);
  if(boot.length+8>4096||app.length<32||4096+app.length>1044464)throw new Error('ESP8266 Arduino image exceeds its eboot/application profile');
  const bytes=new Uint8Array(4096+app.length).fill(0xaa);bytes.set(boot);bytes.set(app,4096);const v=new DataView(bytes.buffer);
  v.setUint32(4112,0,true);v.setUint32(4116,0,true);const crc=rp2040BootCrc(bytes);v.setUint32(4112,bytes.length,true);v.setUint32(4116,crc,true);
  validateEsp8266ArduinoImage(bytes);return bytes;
};
/** @param {Uint8Array} bytes */
export const validateEsp8266ArduinoImage = (bytes) => {
  if(bytes.length<4128||bytes.length>1044464||bytes.length%16||bytes[0]!==0xe9||bytes[1]!==2||bytes[4096]!==0xe9||bytes[4097]!==5)throw new Error('Invalid ESP8266 Arduino eboot/application image');
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength), length=v.getUint32(4112,true),crc=v.getUint32(4116,true),normalized=bytes.slice(),n=new DataView(normalized.buffer);
  if(length!==bytes.length)throw new Error('ESP8266 Arduino length field mismatch');n.setUint32(4112,0,true);n.setUint32(4116,0,true);
  if(rp2040BootCrc(normalized)!==crc)throw new Error('ESP8266 Arduino eboot CRC mismatch');
  let appEnd=0;
  for(const start of [0,4096]){
    let at=start+8,checksum=0xef;
    for(let i=0;i<normalized[start+1];i++){
      if(at+8>bytes.length)throw new Error('Truncated Arduino image segment');
      const address=n.getUint32(at,true),size=n.getUint32(at+4,true);at+=8;
      if(at+size>bytes.length||size&&!(address>=0x3ffe8000&&address+size<=0x40000000||address>=0x40100000&&address+size<=0x40110000||address>=0x40201010&&address+size<=0x40300000))throw new Error('ESP8266 Arduino segment outside memory profile');
      for(const byte of normalized.subarray(at,at+size))checksum^=byte;at+=size;
    }
    const end=start+Math.floor((at-start)/16)*16+15;
    if(end>=bytes.length||normalized[end]!==checksum)throw new Error('ESP8266 Arduino segment checksum mismatch');
    if(start===0&&end>=4096)throw new Error('ESP8266 eboot overlaps application');if(start===4096)appEnd=end+1;
  }
  if(appEnd!==bytes.length)throw new Error('Trailing ESP8266 Arduino payload');
  return {valid:true,errors:[],entry:v.getUint32(4100,true),segmentCount:5,crc};
};
