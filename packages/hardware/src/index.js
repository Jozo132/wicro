import { SerialPort } from 'serialport';

/** @typedef {object} SerialDevice @property {string} path @property {number} [vendorId] @property {number} [productId] @property {string} [manufacturer] @property {string} [serialNumber] */

export class NodeSerialHost {
  async discover() {
    const ports = await SerialPort.list();
    return ports.map((port) => ({
      path: port.path,
      vendorId: port.vendorId ? Number.parseInt(port.vendorId, 16) : undefined,
      productId: port.productId ? Number.parseInt(port.productId, 16) : undefined,
      manufacturer: port.manufacturer,
      serialNumber: port.serialNumber
    }));
  }

  /** @param {string} path @param {number} [baudRate] */
  async open(path, baudRate = 115200) {
    const port = new SerialPort({ path, baudRate, autoOpen: false });
    await new Promise((resolve, reject) => {
      port.open((error) => error ? reject(error) : resolve(undefined));
    });

    return port;
  }
}

export class SerialMonitor {
  /** @param {import('serialport').SerialPort} port */
  constructor(port) {
    /** @type {any} */
    this.port = port;
  }

  /** @param {(line: string) => void} onLine */
  async start(onLine) {
    let pending = '';
    this.onData = (/** @type {any} */ data) => {
      pending += data.toString('utf8');
      const complete = pending.split(/\r?\n/);
      pending = complete.pop() ?? '';
      for (const line of complete) onLine(line);
    };
    this.port.on('data', this.onData);
  }

  async stop() {
    if (this.onData) this.port.off('data', this.onData);
  }

  /** @param {string} text */
  async write(text) {
    await new Promise((resolve, reject) => {
      this.port.write(text, (/** @type {Error|null} */ error) => error ? reject(error) : resolve(undefined));
    });
  }

  async close() {
    await this.stop();
    await new Promise((resolve, reject) => {
      this.port.close((/** @type {Error|null} */ error) => error ? reject(error) : resolve(undefined));
    });
  }
}
