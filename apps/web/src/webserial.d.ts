interface WicroSerialPort {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo?(): { usbVendorId?: number; usbProductId?: number };
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}

interface WicroSerial {
  requestPort(options?: { filters?: Array<{ usbVendorId: number; usbProductId?: number }> }): Promise<WicroSerialPort>;
  getPorts(): Promise<WicroSerialPort[]>;
  addEventListener?(type: string, listener: (event: Event) => void): void;
  removeEventListener?(type: string, listener: (event: Event) => void): void;
}

interface Navigator {
  serial: WicroSerial;
}
