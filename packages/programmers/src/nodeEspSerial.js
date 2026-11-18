import { SerialPort } from 'serialport';

const SLIP_END = 0xc0;
const SLIP_ESC = 0xdb;
const SLIP_ESC_END = 0xdc;
const SLIP_ESC_ESC = 0xdd;

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class NodeEspSerialTransport {
  /** @param {{path:string,baudRate?:number,vid?:number,pid?:number}} options */
  constructor(options) {
    this.path = options.path;
    this.baudRate = options.baudRate ?? 115200;
    this.vid = options.vid;
    this.pid = options.pid;
    this.buffer = new Uint8Array(0);
    /** @type {any} */
    this.port = undefined;
    this.tracing = false;
  }

  getInfo() {
    return this.path;
  }

  getVid() {
    return this.vid;
  }

  getPid() {
    return this.pid;
  }

  /** @param {Uint8Array} bytes */
  hexify(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  /** @param {Uint8Array} bytes */
  hexConvert(bytes) {
    return this.hexify(bytes);
  }

  /** @param {string} message */
  trace(message) {
    if (this.tracing) console.error(message);
  }

  /** @param {Uint8Array} data */
  slipWriter(data) {
    const out = [SLIP_END];
    for (const byte of data) {
      if (byte === SLIP_ESC) out.push(SLIP_ESC, SLIP_ESC_ESC);
      else if (byte === SLIP_END) out.push(SLIP_ESC, SLIP_ESC_END);
      else out.push(byte);
    }
    out.push(SLIP_END);
    return new Uint8Array(out);
  }

  /** @param {Uint8Array} left @param {Uint8Array} right */
  appendArray(left, right) {
    const combined = new Uint8Array(left.length + right.length);
    combined.set(left);
    combined.set(right, left.length);
    return combined;
  }

  /** @param {number} baud @param {object} [serialOptions] */
  async connect(baud = this.baudRate, serialOptions = {}) {
    if (this.port?.isOpen) await this.disconnect();
    this.port = new SerialPort({ path: this.path, baudRate: baud, autoOpen: false });
    await new Promise((resolve, reject) => {
      this.port.open((/** @type {Error|null} */ error) => error ? reject(error) : resolve(undefined));
    });
  }

  async readLoop() {
    if (!this.port) return;
    this.port.on('data', (/** @type {any} */ data) => {
      const chunk = new Uint8Array(data);
      this.buffer = this.appendArray(this.buffer, chunk);
    });
  }

  flushInput() {
    this.buffer = new Uint8Array(0);
  }

  async drainInput(quietMs = 100, maxMs = 400) {
    const deadline = Date.now() + maxMs;
    let previousLength = -1;
    while (Date.now() < deadline && this.buffer.length !== previousLength) {
      previousLength = this.buffer.length;
      await sleep(quietMs);
    }
    this.flushInput();
  }

  async flushOutput() {
    if (!this.port) return;
    await new Promise((resolve, reject) => {
      this.port.drain((/** @type {Error|null} */ error) => error ? reject(error) : resolve(undefined));
    });
  }

  inWaiting() {
    return this.buffer.length;
  }

  peek() {
    return this.buffer;
  }

  /** @param {Uint8Array} data */
  async write(data) {
    if (!this.port?.isOpen) throw new Error('Serial port is not open');
    const packet = this.slipWriter(data);
    await new Promise((resolve, reject) => {
      this.port.write(packet, (/** @type {Error|null} */ error) => error ? reject(error) : resolve(undefined));
    });
  }

  /** @param {number} timeout */
  async read(timeout) {
    let packet = new Uint8Array(0);
    let escaping = false;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      if (this.buffer.length === 0) {
        await sleep(1);
        continue;
      }

      const bytes = this.buffer;
      this.buffer = new Uint8Array(0);
      for (const byte of bytes) {
        if (packet.length === 0 && byte !== SLIP_END) continue;
        if (byte === SLIP_END) {
          if (packet.length > 0) return packet;
          packet = new Uint8Array(0);
        } else if (escaping) {
          escaping = false;
          packet = this.appendArray(packet, new Uint8Array([byte === SLIP_ESC_END ? SLIP_END : byte === SLIP_ESC_ESC ? SLIP_ESC : byte]));
        } else if (byte === SLIP_ESC) {
          escaping = true;
        } else {
          packet = this.appendArray(packet, new Uint8Array([byte]));
        }
      }
    }

    throw new Error('Serial data stream stopped or timed out');
  }

  /** @param {boolean} state */
  async setRTS(state) {
    if (!this.port?.isOpen) return;
    await new Promise((resolve) => {
      this.port.set({ rts: state }, (/** @type {Error|null} */ error) => resolve(undefined));
    });
  }

  /** @param {boolean} state */
  async setDTR(state) {
    if (!this.port?.isOpen) return;
    await new Promise((resolve) => {
      this.port.set({ dtr: state }, (/** @type {Error|null} */ error) => resolve(undefined));
    });
  }

  /** @param {boolean} dtr @param {boolean} rts */
  async setSignals(dtr, rts) {
    if (!this.port?.isOpen) return;
    await new Promise((resolve) => {
      this.port.set({ dtr, rts }, (/** @type {Error|null} */ error) => resolve(undefined));
    });
  }

  /** @param {number} baud @param {object} [serialOptions] */
  async changeBaudrate(baud, serialOptions = {}) {
    if (!this.port?.isOpen) return false;
    await new Promise((resolve, reject) => {
      this.port.update({ baudRate: baud }, (/** @type {Error|null} */ error) => error ? reject(error) : resolve(undefined));
    });
    this.baudRate = baud;
    return true;
  }

  async disconnect() {
    if (!this.port?.isOpen) return;
    await new Promise((resolve, reject) => {
      this.port.close((/** @type {Error|null} */ error) => error ? reject(error) : resolve(undefined));
    });
  }
}
