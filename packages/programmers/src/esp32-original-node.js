import { NodeEspSerialTransport } from './nodeEspSerial.js';
import { flashEsp32Original } from './esp32-original.js';

export class Esp32OriginalNodeProgrammer {
  /** @param {{path:string,expectedMac?:string,onLog?:(message:string)=>void,onProgress?:(event:{stage:string,message:string,percent:number})=>void}} options */
  constructor(options) { this.options = options; }
  /** @param {Uint8Array} image */
  writeFlash(image) { return flashEsp32Original(new NodeEspSerialTransport({ path: this.options.path, baudRate: 115200 }), image, this.options); }
}
