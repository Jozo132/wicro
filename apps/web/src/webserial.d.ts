interface WicroSerialPort {
  readable: ReadableStream<Uint8Array>;
  open(options: { baudRate: number }): Promise<void>;
}

interface WicroSerial {
  requestPort(options: { filters: Array<{ usbVendorId: number; usbProductId: number }> }): Promise<WicroSerialPort>;
}

interface Navigator {
  serial: WicroSerial;
}
