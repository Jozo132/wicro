import { validateRp2350Image } from '../../runtime/src/rp2350-image.js';
import { validateRp2040Image } from '../../runtime/src/rp2040-image.js';

/** @param {number} id @param {number} token @param {Uint8Array} args @param {number} length */
export const picobootPacket = (id, token, args, length) => {
  if (!Number.isInteger(id) || id < 0 || id > 255 || !Number.isInteger(token) || token < 0 || token > 0xffffffff || args.length > 16 || !Number.isInteger(length) || length < 0 || length > 0xffffffff) throw new Error('Invalid PICOBOOT command');
  const bytes = new Uint8Array(32), v = new DataView(bytes.buffer);
  v.setUint32(0, 0x431fd10b, true); v.setUint32(4, token, true); bytes[8]=id;bytes[9]=args.length;v.setUint32(12,length,true);bytes.set(args,16);return bytes;
};
/** @param {number[]} words */
const args32 = (words) => { const bytes=new Uint8Array(words.length*4),v=new DataView(bytes.buffer);words.forEach((word,index)=>v.setUint32(index*4,word,true));return bytes; };

export class PicoBootProgrammer {
  /** @param {{device:any,chip?:'RP2040'|'RP2350',onProgress?:(event:{stage:string,message:string,percent:number})=>void}} options */
  constructor(options) { this.options=options;this.token=0;this.interfaceNumber=1;this.input=4;this.output=3; }
  async open() {
    const d=this.options.device;
    const pid = this.options.chip === 'RP2350' ? 15 : 3;
    if(d.vendorId!==0x2e8a||d.productId!==pid)throw new Error(`Expected ${this.options.chip ?? 'RP2040'} ROM BOOTSEL device`);
    await d.open();
    try {
      if(!d.configuration)await d.selectConfiguration(1);
      const interfaces=d.configuration.interfaces.filter((/** @type {any} */ i)=>i.alternate.interfaceClass===255);
      if(interfaces.length!==1)throw new Error('Select the PICOBOOT vendor interface');
      const iface=interfaces[0];this.interfaceNumber=iface.interfaceNumber;
      const endpoints=iface.alternate.endpoints;
      const input=endpoints.find((/** @type {any} */ e)=>e.type==='bulk'&&e.direction==='in'),output=endpoints.find((/** @type {any} */ e)=>e.type==='bulk'&&e.direction==='out');
      if(!input||!output)throw new Error('PICOBOOT bulk endpoints are missing');
      this.input=input.endpointNumber;this.output=output.endpointNumber;
      await d.claimInterface(this.interfaceNumber);
      const reset=await d.controlTransferOut({requestType:'vendor',recipient:'interface',request:0x41,value:0,index:this.interfaceNumber},new Uint8Array());
      if(reset.status!=='ok')throw new Error('PICOBOOT interface reset failed');
    } catch(error){await d.close();throw error;}
  }
  /** @param {Uint8Array} bytes */
  async out(bytes) { const result=await this.options.device.transferOut(this.output,Uint8Array.from(bytes));if(result.status!=='ok'||result.bytesWritten!==bytes.length)throw new Error('Short/failed PICOBOOT bulk write'); }
  /** @param {number} length */
  async inputBytes(length) { const result=await this.options.device.transferIn(this.input,length);if(result.status!=='ok'||!result.data)throw new Error('Failed PICOBOOT bulk read');return new Uint8Array(result.data.buffer,result.data.byteOffset,result.data.byteLength); }
  /** @param {number} id @param {Uint8Array} [args] @param {Uint8Array|number} [transfer] */
  async command(id,args=new Uint8Array(),transfer=0) {
    const length=typeof transfer==='number'?transfer:transfer.length,token=++this.token;
    await this.out(picobootPacket(id,token,args,length));
    let bytes=new Uint8Array();
    if(id&0x80){bytes=await this.inputBytes(length);if(bytes.length!==length)throw new Error('Short PICOBOOT data read');await this.out(new Uint8Array());}
    else {if(transfer instanceof Uint8Array&&length)await this.out(transfer);const ack=await this.inputBytes(1);if(ack.length!==0)throw new Error('Expected PICOBOOT zero-length ACK');}
    const result=await this.options.device.controlTransferIn({requestType:'vendor',recipient:'interface',request:0x42,value:0,index:this.interfaceNumber},16);
    if(result.status!=='ok'||!result.data||result.data.byteLength!==16)throw new Error('PICOBOOT command status unavailable');
    const v=result.data;
    if(v.getUint32(0,true)!==token||v.getUint32(4,true)!==0||v.getUint8(8)!==id||v.getUint8(9)!==0)throw new Error(`PICOBOOT command ${id} failed (status ${v.getUint32(4,true)})`);
    return bytes;
  }
  /** @param {number} address @param {number} length */
  async readFlash(address,length) {
    if(!Number.isInteger(address)||!Number.isInteger(length)||length<1||address<0x10000000||address+length>0x10200000)throw new Error('PICOBOOT read crosses the conservative 2 MiB flash profile');
    const bytes=new Uint8Array(length);
    for(let offset=0;offset<length;offset+=4096){const size=Math.min(4096,length-offset);bytes.set(await this.command(0x84,args32([address+offset,size]),size),offset);}
    return bytes;
  }
  /** @param {Uint8Array} image @param {{onBackup?:(bytes:Uint8Array)=>Promise<void>,reboot?:boolean}} [options] */
  async writeFlash(image,options={}) {
    const info = this.options.chip === 'RP2350' ? validateRp2350Image(image) : validateRp2040Image(image);
    const eraseLength=Math.ceil(image.length/4096)*4096;
    await this.command(1,Uint8Array.of(1));await this.command(7);
    if(options.onBackup)await options.onBackup(await this.readFlash(0x10000000,eraseLength));
    await this.command(6);
    this.options.onProgress?.({stage:'erase',message:`Erasing ${eraseLength} bytes at 0x10000000`,percent:5});
    await this.command(3,args32([0x10000000,eraseLength]));
    for(let offset=0;offset<image.length;offset+=256){const page=new Uint8Array(256).fill(255);page.set(image.subarray(offset,offset+256));await this.command(5,args32([0x10000000+offset,256]),page);this.options.onProgress?.({stage:'write',message:`Programmed ${Math.min(offset+256,image.length)}/${image.length}`,percent:10+Math.round(Math.min(offset+256,image.length)/image.length*70)});}
    await this.command(7);
    const bytes=await this.readFlash(0x10000000,image.length);
    if(!bytes.every((value,index)=>value===image[index]))throw new Error('PICOBOOT flash readback mismatch');
    this.options.onProgress?.({stage:'verify',message:'PICOBOOT flash readback matched',percent:95});
    if(options.reboot!==false) {
      if (this.options.chip === 'RP2350') await this.command(0x0a,args32(['architecture' in info && info.architecture === 'riscv32' ? 0x20 : 0x10,500,0,0]));
      else await this.command(2,args32([0,0,500]));
    }
    return {ok:true,chip:this.options.chip ?? 'RP2040',mac:undefined,serialNumber:this.options.device.serialNumber,readback:{verified:true,bytes:image.length},reboot:{requested:options.reboot!==false,confirmed:false}};
  }
  async close(){await this.options.device.close();}
}

/** @param {any} device @param {number} nonce */
export const sampleRp2040Runtime = async (device, nonce) => {
  const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, nonce, true);
  const written = await device.transferOut(1, bytes);
  if (written.status !== 'ok' || written.bytesWritten !== 4) throw new Error('RP2040 diagnostic request failed');
  const read = await device.transferIn(2, 64);
  if (read.status !== 'ok' || !read.data || read.data.byteLength !== 40) throw new Error('RP2040 diagnostic response is incomplete');
  const response = new Uint8Array(read.data.buffer, read.data.byteOffset, read.data.byteLength);
  if (new TextDecoder().decode(response.subarray(0, 18)) !== 'WICRO_RP2040_READY' || response[19] !== 1 || read.data.getUint32(28, true) !== nonce || read.data.getUint32(36, true) !== 0x20400001) throw new Error('RP2040 runtime challenge/identity mismatch');
  return { sequence: read.data.getUint32(20, true), microseconds: read.data.getUint32(24, true), heartbeat: read.data.getUint32(32, true), nonce };
};


/** Challenge the actual RP2350 diagnostic runtime and verify its architecture.
 * @param {any} device @param {number} nonce
 */
export const sampleRp2350Runtime = async (device, nonce) => {
  const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, nonce, true);
  const written = await device.transferOut(1, bytes);
  if (written.status !== 'ok' || written.bytesWritten !== 4) throw new Error('RP2350 diagnostic request failed');
  const read = await device.transferIn(2, 64);
  if (read.status !== 'ok' || !read.data || read.data.byteLength !== 40) throw new Error('RP2350 diagnostic response is incomplete');
  const response = new Uint8Array(read.data.buffer, read.data.byteOffset, read.data.byteLength), marker = read.data.getUint32(36, true);
  if (new TextDecoder().decode(response.subarray(0, 18)) !== 'WICRO_RP2350_READY' || response[19] !== 1 || read.data.getUint32(28, true) !== nonce || ![0x23500001,0x23500002].includes(marker)) throw new Error('RP2350 runtime challenge/identity mismatch');
  return { architecture: marker === 0x23500002 ? 'riscv32' : 'armv8m-mainline', sequence: read.data.getUint32(20, true), microseconds: read.data.getUint32(24, true), heartbeat: read.data.getUint32(32, true), nonce };
};
