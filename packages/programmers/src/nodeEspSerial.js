import { SerialPort } from 'serialport';

const SLIP_END = 0xc0;
const SLIP_ESC = 0xdb;
const SLIP_ESC_END = 0xdc;
const SLIP_ESC_ESC = 0xdd;

export const ESP32_C3_USB_JTAG_RESET_STEPS = Object.freeze([
  Object.freeze({ dtr: false, rts: false, delayAfterMs: 100 }),
  Object.freeze({ dtr: true, rts: false, delayAfterMs: 100 }),
  Object.freeze({ dtr: false, rts: true, delayAfterMs: 100 }),
  Object.freeze({ dtr: false, rts: false, delayAfterMs: 50 })
]);

export const ESP32_C3_USB_JTAG_HARD_RESET_STEPS = Object.freeze([
  Object.freeze({ dtr: false, rts: false, delayAfterMs: 20 }),
  Object.freeze({ dtr: false, rts: true, delayAfterMs: 0 }),
  Object.freeze({ dtr: false, rts: false, delayAfterMs: 0 })
]);

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SlipDecoder {
  constructor() {
    /** @type {Uint8Array[]} */
    this.packets = [];
    /** @type {number[]} */
    this.packet = [];
    this.inPacket = false;
    this.escaping = false;
    /** @type {Error|undefined} */
    this.malformedError = undefined;
  }

  reset() {
    this.packets = [];
    this.packet = [];
    this.inPacket = false;
    this.escaping = false;
    /** @type {Error|undefined} */
    this.malformedError = undefined;
  }

  /** @param {Uint8Array} bytes */
  feed(bytes) {
    if (this.malformedError) return;
    for (const byte of bytes) {
      if (byte === SLIP_END) {
        if (this.inPacket && this.packet.length > 0) {
          if (this.packets.length >= 16) {
            this.malformedError = new Error('SLIP receive queue exceeded 16 packets');
            this.resetExceptQueueError();
            return;
          }
          this.packets.push(Uint8Array.from(this.packet));
        }
        this.packet = [];
        this.inPacket = true;
        this.escaping = false;
        continue;
      }

      if (!this.inPacket) continue;
      if (this.escaping) {
        this.escaping = false;
        if (byte === SLIP_ESC_END) this.packet.push(SLIP_END);
        else if (byte === SLIP_ESC_ESC) this.packet.push(SLIP_ESC);
        else {
          this.malformedError = new Error(`Invalid SLIP escape (0xdb, 0x${byte.toString(16).padStart(2, '0')})`);
          this.resetExceptQueueError();
          return;
        }
      } else if (byte === SLIP_ESC) {
        this.escaping = true;
      } else {
        this.packet.push(byte);
      }

      if (this.packet.length > 16 * 1024 * 1024) {
        this.malformedError = new Error('SLIP packet exceeded 16 MB receive limit');
        this.resetExceptQueueError();
        return;
      }
    }
  }

  resetExceptQueueError() {
    /** @type {Error|undefined} */
    const error = this.malformedError;
    this.packets = [];
    this.packet = [];
    this.inPacket = false;
    this.escaping = false;
    this.malformedError = error;
  }

  /** @returns {Uint8Array|undefined} */
  shiftPacket() {
    if (this.malformedError) {
      const error = this.malformedError;
      this.reset();
      throw error;
    }
    return this.packets.shift();
  }

  get queuedBytes() {
    return this.packets.reduce((total, packet) => total + packet.length, 0) + this.packet.length;
  }
}

export class NodeEspSerialTransport {
  /** @param {{path:string,baudRate?:number,vid?:number,pid?:number}} options */
  constructor(options) {
    this.path = options.path;
    this.baudRate = options.baudRate ?? 115200;
    this.vid = options.vid;
    this.pid = options.pid;
    this.buffer = new Uint8Array(0);
    this.decoder = new SlipDecoder();
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
    this.onData = (/** @type {any} */ data) => {
      const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (this.buffer.length + chunk.length > 64 * 1024) {
        this.buffer = new Uint8Array(0);
        this.decoder.reset();
        this.decoder.malformedError = new Error('Serial receive buffer exceeded 64 KB');
        return;
      }
      this.buffer = this.appendArray(this.buffer, chunk);
      this.decoder.feed(this.buffer);
      this.buffer = new Uint8Array(0);
    };
    this.port.on('data', this.onData);
  }

  flushInput() {
    this.buffer = new Uint8Array(0);
    this.decoder.reset();
  }

  async drainInput(quietMs = 100, maxMs = 400) {
    const deadline = Date.now() + maxMs;
    let previousLength = -1;
    while (Date.now() < deadline) {
      const length = this.decoder.queuedBytes + this.buffer.length;
      if (length === 0 || length === previousLength) {
        if (length === previousLength) break;
        previousLength = length;
      } else {
        previousLength = length;
      }
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
    return this.buffer.length + this.decoder.queuedBytes;
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
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const packet = this.decoder.shiftPacket();
      if (packet) return packet;
      await sleep(1);
    }
    throw new Error('Serial data stream stopped or timed out');
  }

  /** @param {boolean} state */
  async setRTS(state) {
    if (!this.port?.isOpen) throw new Error('Serial port is not open');
    await new Promise((resolve, reject) => {
      this.port.set({ rts: state }, (/** @type {Error|null} */ error) => error ? reject(error) : resolve(undefined));
    });
  }

  /** @param {boolean} state */
  async setDTR(state) {
    if (!this.port?.isOpen) throw new Error('Serial port is not open');
    await new Promise((resolve, reject) => {
      this.port.set({ dtr: state }, (/** @type {Error|null} */ error) => error ? reject(error) : resolve(undefined));
    });
  }

  /** @param {boolean} dtr @param {boolean} rts */
  async setSignals(dtr, rts) {
    if (!this.port?.isOpen) throw new Error('Serial port is not open');
    await new Promise((resolve, reject) => {
      this.port.set({ dtr, rts }, (/** @type {Error|null} */ error) => error ? reject(error) : resolve(undefined));
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

  async resetForDownload() {
    if (!this.port?.isOpen) await this.connect(this.baudRate);
    await this.setSignals(true, true);
    await sleep(100);
    await this.setSignals(false, true);
    await sleep(100);
    await this.setSignals(true, false);
    await sleep(100);
    await this.setSignals(true, true);
  }

  async resetIntoApplication() {
    if (!this.port?.isOpen) await this.connect(this.baudRate);
    await this.setSignals(false, false);
    await sleep(100);
    await this.setRTS(true);
    await sleep(100);
    await this.setRTS(false);
  }

  /** @param {readonly Readonly<{dtr:boolean,rts:boolean,delayAfterMs:number}>[]} [steps] */
  async resetUsbJtagWithCdc(steps = ESP32_C3_USB_JTAG_RESET_STEPS) {
    let usbModule;
    try {
      usbModule = await import('usb');
    } catch (error) {
      throw new Error(`Direct USB-JTAG reset is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const devices = await usbModule.usb.getDevices();
    const device = devices.find((/** @type {any} */ item) => item.vendorId === this.vid && item.productId === this.pid);
    if (!device) throw new Error('ESP32-C3 USB JTAG/serial device not found for CDC reset');

    await device.open();
    try {
      try { await device.detachKernelDriver(0); } catch { /* Interface may not be kernel-bound. */ }
      await device.selectConfiguration(1);
      await device.claimInterface(0);
      const setLines = async (/** @type {boolean} */ dtr, /** @type {boolean} */ rts) => {
        const value = (dtr ? 1 : 0) | (rts ? 2 : 0);
        await device.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 0x22, value, index: 0 }, new Uint8Array(0));
      };

      for (const step of steps) {
        await setLines(step.dtr, step.rts);
        if (step.delayAfterMs > 0) await sleep(step.delayAfterMs);
      }
      await device.releaseInterface(0);
    } finally {
      try { await device.attachKernelDriver(0); } catch { /* Interface may already be released to the kernel. */ }
      await device.close();
    }
  }

  async hardResetUsbJtagWithCdc() {
    await this.resetUsbJtagWithCdc(ESP32_C3_USB_JTAG_HARD_RESET_STEPS);
  }

  async touchUsbVcp() {
    await this.connect(1200);
    await this.flushOutput();
    await sleep(300);
    await this.disconnect();
  }

  async disconnect() {
    if (!this.port) return;
    if (this.onData) this.port.off('data', this.onData);
    this.onData = undefined;
    if (this.port.isOpen) {
      await new Promise((resolve, reject) => {
        this.port.close((/** @type {Error|null} */ error) => error ? reject(error) : resolve(undefined));
      });
    }
    this.port = undefined;
  }
}
