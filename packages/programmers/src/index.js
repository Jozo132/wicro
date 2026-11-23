import { SerialPort } from 'serialport';
import { ESPLoader, ClassicReset, UsbJtagSerialReset, HardReset } from 'esptool-js';
import { NodeEspSerialTransport } from './nodeEspSerial.js';

export { NodeEspSerialTransport };

/** @param {number} applicationSize @param {number} [partitionOffset] @param {number} [partitionCapacity] */
export const validateEsp32ApplicationPartition = (applicationSize, partitionOffset = 0x10000, partitionCapacity = 0x180000) => {
  if (!Number.isSafeInteger(applicationSize) || applicationSize <= 0) throw new Error('ESP32 application image size is invalid');
  if (!Number.isSafeInteger(partitionOffset) || partitionOffset < 0) throw new Error('ESP32 application partition offset is invalid');
  if (!Number.isSafeInteger(partitionCapacity) || partitionCapacity <= 0) throw new Error('ESP32 application partition capacity is invalid');
  if (applicationSize > partitionCapacity) throw new Error(`ESP32 application image (${applicationSize} bytes) exceeds partition capacity (${partitionCapacity} bytes)`);
  return { ok: true, partitionOffset, partitionCapacity, applicationSize };
};

/** @param {{address:number,data:Uint8Array}[]} files */
export const validateEsp32FlashImages = (files) => {
  if (files.length === 1 && files[0].address === 0x10000) {
    const application = files[0].data;
    if (!(application instanceof Uint8Array) || application.length === 0) throw new Error('ESP32 application image is empty');
    if (application[0] !== 0xe9) throw new Error('ESP32 application image magic is invalid');
    return { ok: true, addresses: [0x10000], bootloaderBytes: 0, partitionBytes: 0, applicationBytes: application.length };
  }

  const required = new Map([[0x0, 'bootloader'], [0x8000, 'partition'], [0x10000, 'application']]);
  for (const [address, role] of required) {
    const file = files.find((item) => item.address === address);
    if (!file) throw new Error(`Missing ESP32 ${role} image at 0x${address.toString(16)}`);
    if (!(file.data instanceof Uint8Array) || file.data.length === 0) throw new Error(`ESP32 ${role} image is empty`);
  }
  const bootloader = files.find((item) => item.address === 0x0)?.data;
  const partition = files.find((item) => item.address === 0x8000)?.data;
  const application = files.find((item) => item.address === 0x10000)?.data;
  if (bootloader && bootloader[0] !== 0xe9) throw new Error('ESP32 bootloader image magic is invalid');
  if (partition && partition[0] !== 0xaa) throw new Error('ESP32 partition table magic is invalid');
  if (application && application[0] !== 0xe9) throw new Error('ESP32 application image magic is invalid');
  return { ok: true, addresses: [...required.keys()], bootloaderBytes: bootloader?.length ?? 0, partitionBytes: partition?.length ?? 0, applicationBytes: application?.length ?? 0 };
};
export { ProgrammerProtocolRegistry, programmerProtocols } from './protocolRegistry.js';

export class Esp32C3NodeProgrammer {
  /** @param {{path?:string,baudRate?:number,debugLogging?:boolean,rediscoveryTimeoutMs?:number}} [options] */
  constructor(options) {
    this.options = options;
  }

  async findPort() {
    const ports = await SerialPort.list();
    const esp = ports.find((port) => port.vendorId?.toLowerCase() === '303a' && port.productId?.toLowerCase() === '1001');
    if (!esp) throw new Error('ESP32-C3 USB JTAG/serial device not found');
    return esp;
  }

  /** @param {{address:number,data:Uint8Array}[]} files @param {{baudRate?:number,path?:string,resetMode?:'no_reset'|'touch_1200',verifyReadback?:boolean,applicationPartitionOffset?:number,applicationPartitionCapacity?:number}} [options] */
  async writeFlash(files, options = {}) {
    validateEsp32FlashImages(files);
    const port = options.path ? { path: options.path } : await this.findPort();
    const transport = new NodeEspSerialTransport({
      path: port.path,
      baudRate: options.baudRate ?? 115200,
      vid: 0x303a,
      pid: 0x1001
    });
    transport.tracing = this.options?.debugLogging ?? false;
    const stage = (/** @type {string} */ message) => {
      if (this.options?.debugLogging) console.error(`[ESP32-C3] ${message}`);
    };

    stage(`Opening USB JTAG/serial port ${port.path}`);
    await transport.connect(options.baudRate ?? 115200);
    await transport.readLoop();
    stage('Testing existing ROM mode without reset');

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
      let detected = false;
      try {
        if (options.resetMode === 'touch_1200') {
          await transport.disconnect();
          stage('Applying exact USB-JTAG CDC reset and waiting for re-enumeration');
          await transport.resetUsbJtagWithCdc();
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const rediscovered = await waitForEspPortDetailed(this.options?.rediscoveryTimeoutMs ?? 5000);
          transport.path = rediscovered.path;
          await transport.connect(options.baudRate ?? 115200);
          await transport.readLoop();
          await loader.detectChip('no_reset', 7);
          detected = true;
        } else {
          await loader.detectChip('no_reset', 3);
          detected = true;
        }
      } catch {
        if (options.resetMode === 'no_reset') {
          throw new Error('ESP32-C3 is not in ROM download mode. Place it in bootloader mode and retry with --reset-mode=no-reset.');
        }
        await transport.disconnect();
        stage('Applying exact USB-JTAG CDC reset and waiting for re-enumeration');
        await transport.resetUsbJtagWithCdc();
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const rediscovered = await waitForEspPortDetailed(this.options?.rediscoveryTimeoutMs ?? 5000);
        transport.path = rediscovered.path;
        await transport.connect(options.baudRate ?? 115200);
        await transport.readLoop();
        await loader.detectChip('no_reset', 7);
        detected = true;
      }
      if (!detected) throw new Error('ESP32-C3 ROM synchronization did not establish a chip connection');
      await loader.runStub();
      for (const file of files) validateEsp32ApplicationPartition(file.data.length, file.address, file.address === 0x10000 ? 0x180000 : 0x1000000);
      await loader.writeFlash({
        fileArray: files,
        flashMode: 'dio',
        flashFreq: '80m',
        flashSize: '4MB',
        eraseAll: false,
        compress: false
      });
      /** @type {{verified:boolean,bytes:number,matched:boolean}|undefined} */
      let readback;
      if (options.verifyReadback) {
        for (const file of files) {
          const data = await loader.readFlash(file.address, file.data.length);
          const matched = data.length === file.data.length && data.every((value, index) => value === file.data[index]);
          if (!matched) throw new Error(`ESP32 flash readback mismatch at 0x${file.address.toString(16)}`);
          readback = { verified: true, bytes: data.length, matched: true };
        }
      }
      const chipName = loader.chip.CHIP_NAME;
      const mac = await loader.chip.readMac(loader);
      const flashSize = await loader.detectFlashSize();

      /** @type {{requested:boolean,ok:boolean,error?:string}} */
      let rebootStatus;
      try {
        try {
          await loader.flashFinish(true);
        } catch {
          // Stub leave may return status 198 after writeFlash already left flash mode; hard reset below exits download mode cleanly.
        }
        await transport.disconnect();
        await transport.hardResetUsbJtagWithCdc();
        rebootStatus = { requested: true, ok: true };
      } catch (finishError) {
        rebootStatus = { requested: true, ok: false, error: finishError instanceof Error ? finishError.message : String(finishError) };
        stage(`Flash write completed, but hard reset returned ${rebootStatus.error}`);
      }
      return {
        ok: true,
        path: transport.path,
        chip: chipName,
        mac,
        flashSize,
        flashWrite: { ok: true, addresses: files.map((file) => file.address) },
        readback,
        reboot: rebootStatus
      };
    } finally {
      await transport.disconnect();
    }
  }

  /** @param {{baudRate?:number,path?:string}} [options] */
  async probe(options = {}) {
    const port = options.path ? { path: options.path } : await this.findPort();
    const transport = new NodeEspSerialTransport({ path: port.path, baudRate: options.baudRate ?? 115200, vid: 0x303a, pid: 0x1001 });
    transport.tracing = this.options?.debugLogging ?? false;
    await transport.connect(options.baudRate ?? 115200);
    await transport.readLoop();
    const terminal = { clean: () => {}, writeLine: (/** @type {string} */ value) => this.options?.debugLogging ? console.log(value) : undefined, write: () => {} };
    const loader = new ESPLoader({ transport: /** @type {any} */ (transport), baudrate: options.baudRate ?? 115200, romBaudrate: options.baudRate ?? 115200, terminal, enableTracing: this.options?.debugLogging ?? false });
    try {
      try {
        await loader.detectChip('no_reset', 3);
      } catch {
        await transport.disconnect();
        await transport.resetUsbJtagWithCdc();
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const rediscovered = await waitForEspPortDetailed(this.options?.rediscoveryTimeoutMs ?? 5000);
        await transport.connect(options.baudRate ?? 115200);
        await transport.readLoop();
        await loader.detectChip('no_reset', 7);
      }
      return { ok: true, chip: loader.chip.CHIP_NAME, mac: await loader.chip.readMac(loader), path: port.path };
    } finally {
      await transport.disconnect();
    }
  }

  /** @param {{baudRate?:number,path?:string,onLine:(line:string)=>void,onError?:()=>void}} options */
  async monitor(options) {
    const port = options.path ? { path: options.path } : await waitForEspPortDetailed(this.options?.rediscoveryTimeoutMs ?? 5000);
    /** @type {SerialPort|undefined} */
    let serial;
    const deadline = Date.now() + 2000;
    let lastError;
    while (Date.now() < deadline) {
      const candidate = new SerialPort({ path: port.path, baudRate: options.baudRate ?? 115200, autoOpen: false });
      try {
        await new Promise((resolve, reject) => {
          candidate.open((error) => error ? reject(error) : resolve(undefined));
        });
        serial = candidate;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    if (!serial) throw lastError ?? new Error(`Unable to open serial port ${port.path}`);

    let pending = '';
    const onData = (/** @type {any} */ data) => {
      pending += data.toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) options.onLine(line);
    };
    serial.on('data', onData);

    const activeSerial = serial;
    return {
      close: async () => {
        activeSerial.off('data', onData);
        await new Promise((resolve, reject) => {
          activeSerial.close((error) => error ? reject(error) : resolve(undefined));
        });
      }
    };
  }
}

/** @param {number} timeoutMs */
const waitForEspPortDetailed = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ports = await SerialPort.list();
    const esp = ports.find((item) => item.vendorId?.toLowerCase() === '303a' && item.productId?.toLowerCase() === '1001');
    if (esp) return esp;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('ESP32-C3 USB JTAG/serial device disappeared and was not rediscovered');
};

/** @param {number} timeoutMs */
const waitForEspPort = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ports = await SerialPort.list();
    if (ports.some((item) => item.vendorId?.toLowerCase() === '303a' && item.productId?.toLowerCase() === '1001')) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('ESP32-C3 USB JTAG/serial device disappeared and was not rediscovered');
};

/** @param {{path:string,vendorId?:string,productId?:string}[]} ports */
export const findEsp32C3Ports = (ports) => ports.filter((port) =>
  port.vendorId?.toLowerCase() === '303a' && (port.productId?.toLowerCase() === '1001' || port.productId?.toLowerCase() === '1002')
);
