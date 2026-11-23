import { ESPLoader, Transport } from 'esptool-js';
import { validateEsp32ApplicationPartition, validateEsp32FlashImages } from './validation.js';

export { validateEsp32ApplicationPartition, validateEsp32FlashImages };

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Detect browser USB / Serial / OPFS / Worker capabilities for graceful degradation.
 */
export const detectBrowserCapabilities = () => {
  const nav = /** @type {any} */ (globalThis.navigator ?? {});
  const webSerial = Boolean(nav.serial && typeof nav.serial.requestPort === 'function');
  const webUsb = Boolean(nav.usb && typeof nav.usb.requestDevice === 'function');
  const opfs = Boolean(nav.storage && typeof nav.storage.getDirectory === 'function');
  const webAssembly = typeof WebAssembly === 'object' && typeof WebAssembly.compile === 'function';
  const webWorker = typeof Worker === 'function';
  const webCrypto = Boolean(globalThis.crypto?.subtle);
  const secureContext = typeof globalThis.isSecureContext === 'boolean' ? globalThis.isSecureContext : true;

  /** @type {string[]} */
  const warnings = [];
  if (!secureContext) {
    warnings.push('Secure context (HTTPS or localhost) is required for Web Serial, Web Crypto, and OPFS.');
  }
  if (!webSerial) {
    warnings.push('Web Serial API is unavailable in this browser. Use Chromium, Google Chrome, or Microsoft Edge for USB flashing and serial monitoring.');
  }
  if (!opfs) {
    warnings.push('Origin Private File System (OPFS) is unavailable; SDK and toolchain caching will fall back to in-memory session storage.');
  }

  return {
    webSerial,
    webUsb,
    opfs,
    webAssembly,
    webWorker,
    webCrypto,
    secureContext,
    warnings
  };
};

/**
 * Format a human-readable USB port label from Web Serial `getInfo()`.
 * @param {any} port
 */
export const describeWebSerialPort = (port) => {
  if (!port || typeof port.getInfo !== 'function') return 'USB Serial Device';
  const info = port.getInfo() ?? {};
  const vid = typeof info.usbVendorId === 'number' ? info.usbVendorId.toString(16).padStart(4, '0') : null;
  const pid = typeof info.usbProductId === 'number' ? info.usbProductId.toString(16).padStart(4, '0') : null;
  if (vid === '303a' && pid === '1001') return 'ESP32-C3 USB JTAG/Serial (303a:1001)';
  if (vid && pid) return `USB Serial (${vid}:${pid})`;
  return 'USB Serial Device';
};

/**
 * Browser-native Espressif programmer using Web Serial and `esptool-js`.
 * Never performs full-chip erases (`eraseAll: false`) or modifies eFuses.
 */
export class BrowserEsp32Programmer {
  /**
   * @param {{
   *   baudRate?: number,
   *   romBaudRate?: number,
   *   usbVendorId?: number,
   *   usbProductId?: number,
   *   debugLogging?: boolean,
   *   onLog?: (line: string) => void
   * }} [options]
   */
  constructor(options = {}) {
    this.baudRate = options.baudRate ?? 460800;
    this.romBaudRate = options.romBaudRate ?? 115200;
    this.usbVendorId = options.usbVendorId ?? 0x303a;
    this.usbProductId = options.usbProductId ?? 0x1001;
    this.debugLogging = options.debugLogging ?? false;
    this.onLog = options.onLog;
  }

  /**
   * Request a Web Serial port from the user with optional VID/PID filter.
   * @param {{filterByBoard?: boolean}} [options]
   */
  async requestPort(options = {}) {
    const nav = /** @type {any} */ (globalThis.navigator);
    if (!nav?.serial?.requestPort) {
      throw new Error('Web Serial API is unavailable. Open Wicro in Chrome or Edge over localhost/HTTPS.');
    }
    const filters = options.filterByBoard && this.usbVendorId
      ? [{ usbVendorId: this.usbVendorId, ...(this.usbProductId ? { usbProductId: this.usbProductId } : {}) }]
      : [];
    return nav.serial.requestPort(filters.length > 0 ? { filters } : {});
  }

  /**
   * Find a previously authorized port matching this programmer's VID/PID.
   * @param {number} [timeoutMs]
   */
  async rediscoverPort(timeoutMs = 5000) {
    const nav = /** @type {any} */ (globalThis.navigator);
    if (!nav?.serial?.getPorts) return null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ports = await nav.serial.getPorts();
      const match = ports.find((/** @type {any} */ port) => {
        const info = typeof port.getInfo === 'function' ? port.getInfo() : {};
        if (this.usbVendorId && info.usbVendorId !== this.usbVendorId) return false;
        if (this.usbProductId && info.usbProductId !== this.usbProductId) return false;
        return true;
      });
      if (match) return match;
      if (ports.length > 0 && !this.usbVendorId) return ports[0];
      await sleep(120);
    }
    return null;
  }

  /**
   * Flash validated firmware images through Web Serial using `esptool-js`.
   * @param {any} port
   * @param {{address:number,data:Uint8Array}[]} files
   * @param {{
   *   baudRate?: number,
   *   resetMode?: 'default_reset'|'no_reset',
   *   verifyReadback?: boolean,
   *   applicationPartitionCapacity?: number,
   *   onProgress?: (event: {stage:string,message:string,percent?:number,written?:number,total?:number}) => void
   * }} [options]
   */
  async writeFlash(port, files, options = {}) {
    if (!port) throw new Error('A Web Serial port is required for flashing');
    validateEsp32FlashImages(files);
    const appCapacity = options.applicationPartitionCapacity ?? 0x180000;
    for (const file of files) {
      validateEsp32ApplicationPartition(file.data.length, file.address, file.address === 0x10000 ? appCapacity : 0x1000000);
    }

    const baudrate = options.baudRate ?? this.baudRate;
    const onProgress = options.onProgress;
    const log = (/** @type {string} */ text) => {
      const trimmed = text.trimEnd();
      if (trimmed) this.onLog?.(trimmed);
    };

    const transport = new Transport(port, this.debugLogging);
    const terminal = {
      clean: () => {},
      writeLine: (/** @type {string} */ value) => log(value),
      write: (/** @type {string} */ value) => log(value)
    };

    const loader = new ESPLoader({
      transport,
      baudrate,
      romBaudrate: this.romBaudRate,
      terminal,
      enableTracing: this.debugLogging
    });

    try {
      onProgress?.({ stage: 'connect', message: 'Connecting to ESP32 ROM bootloader…', percent: 5 });
      const resetMode = options.resetMode ?? 'default_reset';
      try {
        await loader.main(resetMode);
      } catch (primaryError) {
        if (resetMode === 'no_reset') throw primaryError;
        onProgress?.({ stage: 'connect', message: 'Retrying ROM sync without hardware reset…', percent: 8 });
        try {
          await transport.disconnect();
        } catch {
          // Ignore close errors before retry.
        }
        await sleep(150);
        await loader.main('no_reset');
      }

      const chipName = loader.chip?.CHIP_NAME ?? 'ESP32';
      let mac = '';
      try {
        mac = await loader.chip.readMac(loader);
      } catch {
        mac = 'unknown';
      }
      onProgress?.({ stage: 'flash', message: `Connected to ${chipName} (${mac}). Flashing application…`, percent: 15 });

      await loader.writeFlash({
        fileArray: files.map((file) => ({ data: file.data, address: file.address })),
        flashMode: 'dio',
        flashFreq: '80m',
        flashSize: 'keep',
        eraseAll: false,
        compress: true,
        reportProgress: (_fileIndex, written, total) => {
          const ratio = total > 0 ? written / total : 1;
          const percent = Math.min(90, Math.round(15 + ratio * 75));
          onProgress?.({
            stage: 'flash',
            message: `Flashing ${Math.round(ratio * 100)}% (${written.toLocaleString()} / ${total.toLocaleString()} bytes)…`,
            percent,
            written,
            total
          });
        }
      });

      /** @type {{verified:boolean,bytes:number,matched:boolean}|undefined} */
      let readback;
      if (options.verifyReadback) {
        onProgress?.({ stage: 'verify', message: 'Verifying flash readback…', percent: 92 });
        let totalVerified = 0;
        for (const file of files) {
          const data = await loader.readFlash(file.address, file.data.length);
          const matched = data.length === file.data.length && data.every((value, idx) => value === file.data[idx]);
          if (!matched) {
            throw new Error(`Flash readback verification mismatch at 0x${file.address.toString(16)}`);
          }
          totalVerified += data.length;
        }
        readback = { verified: true, bytes: totalVerified, matched: true };
      }

      onProgress?.({ stage: 'reset', message: 'Resetting board into application mode…', percent: 96 });
      /** @type {{requested:boolean,ok:boolean,error?:string}} */
      let reboot = { requested: true, ok: true };
      try {
        await loader.after('hard_reset', true);
      } catch (resetError) {
        try {
          await transport.setDTR(false);
          await transport.setRTS(true);
          await sleep(100);
          await transport.setRTS(false);
        } catch (fallbackError) {
          reboot = {
            requested: true,
            ok: false,
            error: fallbackError instanceof Error ? fallbackError.message : (resetError instanceof Error ? resetError.message : String(resetError))
          };
        }
      }

      onProgress?.({ stage: 'done', message: `Flashed ${chipName} successfully.`, percent: 100 });
      return {
        ok: true,
        chip: chipName,
        mac,
        flashWrite: { ok: true, addresses: files.map((file) => file.address) },
        readback,
        reboot
      };
    } finally {
      try {
        await transport.disconnect();
      } catch {
        // Port may already be closed or re-enumerating after hard reset.
      }
    }
  }
}
