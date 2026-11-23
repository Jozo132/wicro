/**
 * Browser-native Web Serial monitor and exclusive device ownership coordinator.
 * Ensures build, flash, and serial monitor workflows never conflict over the
 * same USB serial port, and recovers cleanly across USB re-enumeration.
 */

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @typedef {object} SerialMonitorLineEvent
 * @property {string} text
 * @property {number} timestamp
 * @property {'rx'|'tx'|'system'} direction
 */

export class BrowserSerialMonitor {
  /**
   * @param {{
   *   onLine: (event: SerialMonitorLineEvent) => void,
   *   onStateChange?: (state: 'disconnected'|'connecting'|'connected'|'reconnecting', detail?: string) => void
   * }} options
   */
  constructor(options) {
    this.onLine = options.onLine;
    this.onStateChange = options.onStateChange;
    /** @type {any} */
    this.port = null;
    this.baudRate = 115200;
    /** @type {ReadableStreamDefaultReader<Uint8Array>|null} */
    this.reader = null;
    this.running = false;
    this.closing = false;
    /** @type {Promise<void>|null} */
    this.readLoopPromise = null;
  }

  get connected() {
    return Boolean(this.port && this.running);
  }

  /**
   * Open and start monitoring a Web Serial port.
   * @param {any} port
   * @param {number} [baudRate]
   */
  async connect(port, baudRate = 115200) {
    if (!port) throw new Error('A Web Serial port is required');
    await this.disconnect();
    this.port = port;
    this.baudRate = baudRate;
    this.closing = false;
    this.onStateChange?.('connecting', `Opening serial port at ${baudRate} baud…`);

    if (!port.readable) {
      await port.open({ baudRate });
    }
    this.running = true;
    this.onStateChange?.('connected', `Connected at ${baudRate} baud`);
    this.readLoopPromise = this.pump();
  }

  async pump() {
    const decoder = new TextDecoder();
    let pending = '';

    try {
      while (this.running && this.port?.readable) {
        const reader = this.port.readable.getReader();
        this.reader = reader;
        try {
          while (this.running) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;
            pending += decoder.decode(value, { stream: true });
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() ?? '';
            const now = Date.now();
            for (const line of lines) {
              this.onLine({ text: line, timestamp: now, direction: 'rx' });
            }
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // Reader already released.
          }
          this.reader = null;
        }
      }
      if (pending.length > 0) {
        this.onLine({ text: pending, timestamp: Date.now(), direction: 'rx' });
      }
    } catch (error) {
      if (!this.closing) {
        const message = error instanceof Error ? error.message : String(error);
        this.onLine({ text: `[Serial] ${message}`, timestamp: Date.now(), direction: 'system' });
      }
    } finally {
      this.running = false;
      if (!this.closing) {
        this.onStateChange?.('disconnected', 'Serial connection closed');
      }
    }
  }

  /**
   * Write text to the connected serial port.
   * @param {string} text
   * @param {'\n'|'\r\n'|''} [lineEnding]
   */
  async write(text, lineEnding = '\n') {
    if (!this.port?.writable) throw new Error('Serial port is not open for writing');
    const writer = this.port.writable.getWriter();
    try {
      const payload = `${text}${lineEnding}`;
      await writer.write(new TextEncoder().encode(payload));
      this.onLine({ text, timestamp: Date.now(), direction: 'tx' });
    } finally {
      writer.releaseLock();
    }
  }

  async disconnect() {
    this.closing = true;
    this.running = false;
    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch {
        // Ignore cancel errors during shutdown.
      }
    }
    if (this.readLoopPromise) {
      try {
        await this.readLoopPromise;
      } catch {
        // Ignore read loop errors during shutdown.
      }
      this.readLoopPromise = null;
    }
    if (this.port) {
      try {
        await this.port.close();
      } catch {
        // Port may already be closed or unplugged.
      }
    }
    this.closing = false;
    this.onStateChange?.('disconnected');
  }
}

/**
 * Coordinates exclusive USB serial ownership between flashing and serial monitoring,
 * including automatic recovery across USB re-enumeration.
 */
export class BrowserDeviceCoordinator {
  /**
   * @param {{
   *   monitor: BrowserSerialMonitor,
   *   onDeviceChange?: (info: {connected:boolean,label:string,state:string}) => void
   * }} options
   */
  constructor(options) {
    this.monitor = options.monitor;
    this.onDeviceChange = options.onDeviceChange;
    /** @type {any} */
    this.port = null;
    this.portInfo = { usbVendorId: /** @type {number|undefined} */ (undefined), usbProductId: /** @type {number|undefined} */ (undefined) };
    this.baudRate = 115200;
    this.flashing = false;
    this.autoReconnect = true;
    this.boundOnDisconnect = (/** @type {any} */ event) => { void this.handleDisconnect(event); };
    this.boundOnConnect = (/** @type {any} */ event) => { void this.handleConnect(event); };

    const nav = /** @type {any} */ (globalThis.navigator);
    if (nav?.serial?.addEventListener) {
      nav.serial.addEventListener('disconnect', this.boundOnDisconnect);
      nav.serial.addEventListener('connect', this.boundOnConnect);
    }
  }

  /** @param {any} port */
  setPort(port) {
    this.port = port;
    const info = typeof port?.getInfo === 'function' ? port.getInfo() : {};
    this.portInfo = { usbVendorId: info.usbVendorId, usbProductId: info.usbProductId };
  }

  /**
   * Release monitor ownership so a programmer can exclusively own the port for flashing.
   */
  async acquireForFlash() {
    const wasMonitoring = this.monitor.connected;
    this.flashing = true;
    if (wasMonitoring) {
      await this.monitor.disconnect();
    } else if (this.port?.readable) {
      try {
        await this.port.close();
      } catch {
        // Ignore if already closed.
      }
    }
    return { port: this.port, wasMonitoring };
  }

  /**
   * Return port ownership after flashing, optionally waiting for USB re-enumeration
   * and reconnecting the serial monitor automatically.
   * @param {{reconnectMonitor?: boolean, baudRate?: number, rediscoverTimeoutMs?: number}} [options]
   */
  async releaseAfterFlash(options = {}) {
    this.flashing = false;
    const baudRate = options.baudRate ?? this.baudRate;
    this.baudRate = baudRate;
    if (!options.reconnectMonitor) return;

    const timeoutMs = options.rediscoverTimeoutMs ?? 5000;
    const deadline = Date.now() + timeoutMs;
    await sleep(350);

    while (Date.now() < deadline) {
      const candidate = await this.findMatchingPort() ?? this.port;
      if (candidate) {
        try {
          this.setPort(candidate);
          await this.monitor.connect(candidate, baudRate);
          return;
        } catch {
          await sleep(180);
        }
      } else {
        await sleep(180);
      }
    }
  }

  async findMatchingPort() {
    const nav = /** @type {any} */ (globalThis.navigator);
    if (!nav?.serial?.getPorts) return this.port;
    const ports = await nav.serial.getPorts();
    if (this.portInfo.usbVendorId !== undefined) {
      const matched = ports.find((/** @type {any} */ p) => {
        const info = typeof p.getInfo === 'function' ? p.getInfo() : {};
        return info.usbVendorId === this.portInfo.usbVendorId &&
          (this.portInfo.usbProductId === undefined || info.usbProductId === this.portInfo.usbProductId);
      });
      if (matched) return matched;
    }
    return ports[0] ?? null;
  }

  /** @param {any} event */
  async handleDisconnect(event) {
    if (this.flashing) return;
    if (event?.target && this.port && event.target !== this.port) return;
    await this.monitor.disconnect();
    this.onDeviceChange?.({ connected: false, label: 'Device disconnected', state: 'disconnected' });
  }

  /** @param {any} event */
  async handleConnect(event) {
    if (this.flashing || !this.autoReconnect) return;
    const port = event?.target ?? await this.findMatchingPort();
    if (!port) return;
    const info = typeof port.getInfo === 'function' ? port.getInfo() : {};
    if (this.portInfo.usbVendorId !== undefined && info.usbVendorId !== this.portInfo.usbVendorId) return;
    this.setPort(port);
    try {
      await sleep(250);
      await this.monitor.connect(port, this.baudRate);
      this.onDeviceChange?.({ connected: true, label: 'Device reconnected', state: 'connected' });
    } catch {
      // User can manually reconnect if port is busy.
    }
  }

  dispose() {
    const nav = /** @type {any} */ (globalThis.navigator);
    if (nav?.serial?.removeEventListener) {
      nav.serial.removeEventListener('disconnect', this.boundOnDisconnect);
      nav.serial.removeEventListener('connect', this.boundOnConnect);
    }
    void this.monitor.disconnect();
  }
}
