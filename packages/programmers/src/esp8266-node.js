import { NodeEspSerialTransport } from './nodeEspSerial.js';
import { flashEsp8266 } from './esp8266.js';

export class Esp8266NodeProgrammer {
  /** @param {{path:string,expectedMac?:string,onLog?:(message:string)=>void,onProgress?:(event:{stage:string,message:string,percent:number})=>void}} options */
  constructor(options) { this.options = options; }
  /** @param {Uint8Array} image */
  writeFlash(image) { return flashEsp8266(new NodeEspSerialTransport({ path: this.options.path, baudRate: 115200 }), image, this.options); }
}
