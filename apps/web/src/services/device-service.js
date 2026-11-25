import { Transport } from 'esptool-js';
import { createDefaultPlatformRegistry } from '../../../../packages/core/src/index.js';
import {
  BrowserEsp32Programmer,
  NanoBrowserProgrammer,
  Rp2040BrowserProgrammer,
  Rp2350BrowserProgrammer,
  StLinkBrowserProgrammer,
  flashEsp8266,
  flashEsp32Original,
  BrowserCdcDfuProgrammer,
  describeWebSerialPort,
  detectBrowserCapabilities
} from '../../../../packages/programmers/src/browser.js';
import { BrowserDeviceCoordinator, BrowserSerialMonitor } from '../../../../packages/hardware/src/browser.js';

const platforms = createDefaultPlatformRegistry();

/**
 * Platform-independent browser device & flashing service.
 * Selects the canonical programmer adapter for the active board and coordinates
 * exclusive USB port ownership between flashing and serial monitoring.
 */
export class IdeDeviceService {
  /**
   * @param {{
   *   onSerialLine: (line: {text:string,timestamp:number,direction:'rx'|'tx'|'system'}) => void,
   *   onDeviceStatus: (status: {connected:boolean,state:string,label:string}) => void,
   *   onLog: (line: string) => void
   * }} callbacks
   */
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.capabilities = detectBrowserCapabilities();
    this.monitor = new BrowserSerialMonitor({
      onLine: (event) => callbacks.onSerialLine(event),
      onStateChange: (state, detail) => {
        callbacks.onDeviceStatus({
          connected: state === 'connected',
          state,
          label: detail ?? (this.coordinator.port ? describeWebSerialPort(this.coordinator.port) : 'No device')
        });
      }
    });
    this.coordinator = new BrowserDeviceCoordinator({
      monitor: this.monitor,
      onDeviceChange: (info) => callbacks.onDeviceStatus(info)
    });
  }

  /**
   * Resolve whether a board has a supported browser programmer.
   * @param {import('../state/ide-store.js').BoardCatalogEntry | null} board
   */
  resolveProgrammerForBoard(board) {
    if (!board) return null;
    const platformId = String(board.metadata?.platform ?? '');
    const platform = platformId ? platforms.getPlatform(platformId) : null;
    const programmerId = board.metadata?.programmerId ?? platform?.programmerId ?? (platformId === 'espressif-esp32c3' ? 'esp32-c3-usb-jtag' : null);
    if (!programmerId) return null;
    const descriptor = platforms.getProgrammer(programmerId);
    return {
      id: programmerId,
      descriptor,
      supportedInBrowser: Boolean(descriptor?.browserProtocols?.length)
    };
  }

  /**
   * Prompt the user to select a USB serial port and connect the serial monitor.
   * @param {import('../state/ide-store.js').BoardCatalogEntry | null} board
   * @param {number} baudRate
   */
  async connectMonitor(board, baudRate) {
    if (!this.capabilities.webSerial) {
      throw new Error('Web Serial API is unavailable in this browser. Use Chrome or Edge.');
    }
    const vid = board?.metadata?.usbVendorId ? Number.parseInt(String(board.metadata.usbVendorId), 16) : undefined;
    const pid = board?.metadata?.usbProductId ? Number.parseInt(String(board.metadata.usbProductId), 16) : undefined;
    const nav = /** @type {any} */ (navigator);
    const filters = vid ? [{ usbVendorId: vid, ...(pid ? { usbProductId: pid } : {}) }] : [];
    const port = await nav.serial.requestPort(filters.length > 0 ? { filters } : {});
    this.coordinator.setPort(port);
    this.coordinator.baudRate = baudRate;
    await this.monitor.connect(port, baudRate);
    this.callbacks.onDeviceStatus({
      connected: true,
      state: 'connected',
      label: describeWebSerialPort(port)
    });
  }

  async disconnectMonitor() {
    await this.monitor.disconnect();
    this.callbacks.onDeviceStatus({
      connected: false,
      state: 'disconnected',
      label: this.coordinator.port ? `${describeWebSerialPort(this.coordinator.port)} (disconnected)` : 'No device'
    });
  }

  /** @param {string} text @param {'\n'|'\r\n'|''} lineEnding */
  async sendSerial(text, lineEnding = '\n') {
    await this.monitor.write(text, lineEnding);
  }

  /**
   * Flash a browser-built firmware binary to the connected board, coordinating
   * monitor disconnect, flashing, optional readback verification, hard reset,
   * and automatic serial monitor reconnection.
   * @param {{
   *   board: import('../state/ide-store.js').BoardCatalogEntry,
   *   firmwareBin: Uint8Array,
   *   verifyReadback?: boolean,
   *   autoMonitor?: boolean,
   *   monitorBaudRate?: number,
   *   onProgress?: (event: {stage:string,message:string,percent?:number}) => void
   * }} options
   */
  async flashFirmware(options) {
    if (options.board.metadata?.platform === 'st-stm32f103-swd') {
      const programmer = new StLinkBrowserProgrammer({ onProgress: options.onProgress });
      const selection = programmer.requestDevice();
      await this.coordinator.acquireForFlash();
      try { return await programmer.writeFlash(await selection, options.firmwareBin, Number(options.board.metadata.flashCapacityBytes)); }
      finally { await this.coordinator.releaseAfterFlash({ reconnectMonitor: false }); }
    }
    if (['raspberrypi-rp2040-zero', 'raspberrypi-rp2350'].includes(String(options.board.metadata?.platform))) {
      const Programmer = options.board.metadata?.platform === 'raspberrypi-rp2350' ? Rp2350BrowserProgrammer : Rp2040BrowserProgrammer;
      const programmer = new Programmer({ onProgress: options.onProgress });
      const selection = programmer.requestRomDevice();
      await this.coordinator.acquireForFlash();
      try { return await programmer.writeFlash(await selection, options.firmwareBin); }
      finally { await this.coordinator.releaseAfterFlash({ reconnectMonitor: false }); }
    }
    if (options.board.metadata?.cdcDfu) {
      const programmer = new BrowserCdcDfuProgrammer({ profile: options.board.metadata.cdcDfu });
      // Request permission before awaiting monitor cleanup, preserving activation.
      const selection = programmer.requestDfuDevice();
      await this.coordinator.acquireForFlash();
      try { return await programmer.writeFlash(await selection, options.firmwareBin, { onProgress: options.onProgress }); }
      finally { await this.coordinator.releaseAfterFlash({ reconnectMonitor: false }); }
    }

    if (options.board.metadata?.platform === 'arduino-nano-avr') {
      const nav = /** @type {any} */ (navigator);
      if (!nav.serial) throw new Error('Web Serial is required for Nano');
      const selection = this.coordinator.port ? Promise.resolve(this.coordinator.port) : nav.serial.requestPort({ filters: [{ usbVendorId: 0x1a86, usbProductId: 0x7523 }] });
      await this.coordinator.acquireForFlash();
      try {
        const port = await selection; this.coordinator.setPort(port);
        const result = await new NanoBrowserProgrammer({ baudRate: Number(options.board.metadata.uploadBaud) || 115200, onProgress: options.onProgress }).writeFlash(port, options.firmwareBin);
        await this.coordinator.releaseAfterFlash({ reconnectMonitor: Boolean(options.autoMonitor), baudRate: options.monitorBaudRate ?? 115200 });
        return result;
      } catch (error) { await this.coordinator.releaseAfterFlash({ reconnectMonitor: false }); throw error; }
    }

    if (['espressif-esp8266-bare-metal', 'espressif-esp32-original-bare-metal'].includes(options.board.metadata?.platform)) {
      const originalEsp32 = options.board.metadata.platform === 'espressif-esp32-original-bare-metal';
      const nav = /** @type {any} */ (navigator);
      if (!nav.serial) throw new Error('Web Serial is required for UART upload');
      const selection = this.coordinator.port ? Promise.resolve(this.coordinator.port) : nav.serial.requestPort(originalEsp32 ? {} : { filters: [{ usbVendorId: 0x1a86, usbProductId: 0x7523 }] });
      await this.coordinator.acquireForFlash();
      try {
        const port = await selection;
        this.coordinator.setPort(port);
        const upload = originalEsp32 ? flashEsp32Original : flashEsp8266;
        const result = await upload(new Transport(port), options.firmwareBin, { onLog: this.callbacks.onLog, onProgress: options.onProgress });
        await this.coordinator.releaseAfterFlash({ reconnectMonitor: Boolean(options.autoMonitor), baudRate: options.monitorBaudRate ?? 115200 });
        return result;
      } catch (error) { await this.coordinator.releaseAfterFlash({ reconnectMonitor: false }); throw error; }
    }

    if (!this.capabilities.webSerial) {
      throw new Error('Web Serial API is unavailable in this browser. Use Chrome or Edge to flash hardware.');
    }
    const programmerInfo = this.resolveProgrammerForBoard(options.board);
    if (!programmerInfo?.supportedInBrowser) {
      const name = programmerInfo?.descriptor?.name ?? options.board.name;
      throw new Error(`Browser USB flashing is not yet supported for ${name}. Download the generated firmware artifact or use the Wicro CLI.`);
    }

    const vid = options.board.metadata?.usbVendorId ? Number.parseInt(String(options.board.metadata.usbVendorId), 16) : 0x303a;
    const pid = options.board.metadata?.usbProductId ? Number.parseInt(String(options.board.metadata.usbProductId), 16) : 0x1001;
    const uploadBaud = Number(options.board.metadata?.uploadBaud) || 460800;

    const programmer = new BrowserEsp32Programmer({
      baudRate: uploadBaud,
      romBaudRate: 115200,
      usbVendorId: vid,
      usbProductId: pid,
      onLog: (line) => this.callbacks.onLog(line)
    });

    const { port: existingPort } = await this.coordinator.acquireForFlash();
    let port = existingPort ?? await programmer.rediscoverPort(400);
    if (!port) {
      port = await programmer.requestPort({ filterByBoard: true });
    }
    this.coordinator.setPort(port);

    try {
      const result = await programmer.writeFlash(
        port,
        [{ address: 0x10000, data: options.firmwareBin }],
        {
          baudRate: uploadBaud,
          verifyReadback: Boolean(options.verifyReadback),
          onProgress: options.onProgress
        }
      );

      if (options.autoMonitor) {
        options.onProgress?.({ stage: 'monitor', message: 'Reconnecting serial monitor after reset…', percent: 98 });
        await this.coordinator.releaseAfterFlash({
          reconnectMonitor: true,
          baudRate: options.monitorBaudRate ?? Number(options.board.metadata?.monitorBaud) ?? 115200,
          rediscoverTimeoutMs: 5000
        });
      } else {
        await this.coordinator.releaseAfterFlash({ reconnectMonitor: false });
      }

      return result;
    } catch (error) {
      await this.coordinator.releaseAfterFlash({ reconnectMonitor: false });
      throw error;
    }
  }

  /** @param {import('../state/ide-store.js').BoardCatalogEntry|null} board */
  async enterCdcDfu(board) {
    if (!board?.metadata?.cdcDfu) throw new Error('Select an explicit CDC-DFU board profile');
    const programmer = new BrowserCdcDfuProgrammer({ profile: board.metadata.cdcDfu });
    const selection = programmer.requestRuntimePort();
    await this.coordinator.acquireForFlash();
    try {
      await programmer.trigger(await selection);
      this.callbacks.onLog('CDC trigger sent. Wait for DFU enumeration, then click Flash and select STM32 BOOTLOADER. First provisioning requires BOOT0/reset.');
    } finally { await this.coordinator.releaseAfterFlash({ reconnectMonitor: false }); }
  }

  async enterRp2040Rom(rp2350 = false) {
    const programmer = rp2350 ? new Rp2350BrowserProgrammer() : new Rp2040BrowserProgrammer();
    const selection = programmer.requestRuntimeDevice();
    await this.coordinator.acquireForFlash();
    try { await programmer.enterRom(await selection); this.callbacks.onLog('RP2 ROM entry requested. Click Flash after ROM enumeration; first provisioning requires BOOT + reset.'); }
    finally { await this.coordinator.releaseAfterFlash({ reconnectMonitor: false }); }
  }

  dispose() {
    this.coordinator.dispose();
  }
}
