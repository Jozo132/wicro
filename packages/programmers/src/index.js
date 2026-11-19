import { SerialPort } from 'serialport';
import { ESPLoader, ClassicReset, UsbJtagSerialReset, HardReset } from 'esptool-js';
import { NodeEspSerialTransport } from './nodeEspSerial.js';

export { NodeEspSerialTransport };
export { ProgrammerProtocolRegistry, programmerProtocols } from './protocolRegistry.js';

export class Esp32C3NodeProgrammer {
  /** @param {{path:string,baudRate?:number,debugLogging?:boolean}} [options] */
  constructor(options) {
    this.options = options;
  }

  async findPort() {
    const ports = await SerialPort.list();
    const esp = ports.find((port) => port.vendorId?.toLowerCase() === '303a' && port.productId?.toLowerCase() === '1001');
    if (!esp) throw new Error('ESP32-C3 USB JTAG/serial device not found');
    return esp;
  }

  /** @param {{address:number,data:Uint8Array}[]} files @param {{baudRate?:number,path?:string}} [options] */
  async writeFlash(files, options = {}) {
    const port = options.path ? { path: options.path } : await this.findPort();
    const transport = new NodeEspSerialTransport({
      path: port.path,
      baudRate: options.baudRate ?? 115200,
      vid: 0x303a,
      pid: 0x1001
    });
    transport.tracing = this.options?.debugLogging ?? false;
    await transport.touchUsbVcp();
    await transport.resetForDownload();
    await transport.disconnect();
    await transport.touchUsbVcp();
    await transport.resetForDownload();
    await transport.disconnect();

    const terminal = {
      clean: () => {},
      writeLine: (/** @type {string} */ value) => console.log(value),
      write: (/** @type {string} */ value) => process.stdout.write(value)
    };

    const loader = new ESPLoader({
      transport: /** @type {any} */ (transport),
      baudrate: options.baudRate ?? 115200,
      romBaudrate: options.baudRate ?? 115200,
      terminal,
      resetConstructors: {
        classicReset: (t, delay) => new ClassicReset(t, delay),
        usbJTAGSerialReset: (t) => new UsbJtagSerialReset(t),
        hardReset: (t, usingUsbOtg) => new HardReset(t, usingUsbOtg)
      },
      enableTracing: this.options?.debugLogging ?? false
    });

    try {
      try {
        await loader.detectChip('default_reset', 7);
      } catch (error) {
        throw new Error(`ESP32-C3 native USB VCP did not enter ROM download mode. Use BOOT/RESET for the first flash or use a USB-UART adapter: ${error instanceof Error ? error.message : String(error)}`);
      }
      await loader.writeFlash({
        fileArray: files,
        flashMode: 'dio',
        flashFreq: '80m',
        flashSize: 'detect',
        eraseAll: false,
        compress: true
      });
      await loader.flashFinish(true);
      return {
        ok: true,
        chip: loader.chip.CHIP_NAME,
        mac: await loader.chip.readMac(loader),
        flashSize: await loader.detectFlashSize()
      };
    } finally {
      await transport.disconnect();
    }
  }

  /** @param {{baudRate?:number,path?:string,onLine:(line:string)=>void,onError?:()=>void}} options */
  async monitor(options) {
    const port = options.path ? { path: options.path } : await this.findPort();
    const serial = new SerialPort({ path: port.path, baudRate: options.baudRate ?? 115200, autoOpen: false });
    await new Promise((resolve, reject) => {
      serial.open((error) => error ? reject(error) : resolve(undefined));
    });

    let pending = '';
    const onData = (/** @type {any} */ data) => {
      pending += data.toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) options.onLine(line);
    };
    serial.on('data', onData);

    return {
      close: async () => {
        serial.off('data', onData);
        await new Promise((resolve, reject) => {
          serial.close((error) => error ? reject(error) : resolve(undefined));
        });
      }
    };
  }
}

/** @param {{path:string,vendorId?:string,productId?:string}[]} ports */
export const findEsp32C3Ports = (ports) => ports.filter((port) =>
  port.vendorId?.toLowerCase() === '303a' && (port.productId?.toLowerCase() === '1001' || port.productId?.toLowerCase() === '1002')
);
