import { ESPLoader } from 'esptool-js';
import { validateEsp8266Image } from '../../runtime/src/esp8266-image.js';

/** esptool-js 0.7.1 uses zero as the absent ESP8266 DLEN-register sentinel,
 * while its SPI implementation tests for nullish values. Select its real legacy
 * USR1 bit-length path instead of writing lengths into the SPI command register.
 * @param {any} chip
 */
export const configureEsp8266Spi = (chip) => {
  if (chip.CHIP_NAME !== 'ESP8266') throw new Error('Expected an ESP8266 ROM target');
  if (chip.SPI_MOSI_DLEN_OFFS === 0 && chip.SPI_MISO_DLEN_OFFS === 0) {
    chip.SPI_MOSI_DLEN_OFFS = undefined;
    chip.SPI_MISO_DLEN_OFFS = undefined;
  }
};

/** Shared Node/Web Serial uploader for the 4 MiB RAM-only ESP8266 board profile.
 * @param {any} transport @param {Uint8Array} image
 * @param {{expectedMac?:string,onLog?:(message:string)=>void,onProgress?:(event:{stage:string,message:string,percent:number})=>void}} [options]
 */
export const flashEsp8266 = async (transport, image, options = {}) => {
  validateEsp8266Image(image);
  if (image.length > 0x20000 || image[2] !== 2 || image[3] !== 0x40) throw new Error('This ESP8266 profile requires a bounded DIO/40MHz/4MiB ROM image');
  const log = (/** @type {string} */ message) => options.onLog?.(message.trimEnd());
  const loader = new ESPLoader({ transport, baudrate: 115200, romBaudrate: 115200, terminal: { clean: () => {}, writeLine: log, write: log } });
  try {
    options.onProgress?.({ stage: 'connect', message: 'Entering ESP8266 ROM through DTR/RTS', percent: 5 });
    await loader.detectChip('default_reset', 7);
    configureEsp8266Spi(loader.chip);
    const mac = await loader.chip.readMac(loader);
    if (options.expectedMac && mac.toLowerCase() !== options.expectedMac.toLowerCase()) throw new Error('Connected ESP8266 MAC does not match the selected hardware target');
    const crystalMHz = await loader.chip.getCrystalFreq(loader);
    if (crystalMHz !== 26) throw new Error('This early-ROM UART firmware profile requires a detected 26 MHz crystal');
    await loader.runStub();
    const flashId = await loader.readFlashId();
    const capacity = 2 ** (flashId >>> 16 & 255);
    if (capacity !== 4194304) throw new Error(`This firmware profile requires detected 4 MiB flash; JEDEC=0x${flashId.toString(16)}`);
    await loader.writeFlash({ fileArray: [{ address: 0, data: image }], flashMode: 'keep', flashFreq: 'keep', flashSize: 'keep', eraseAll: false, compress: true,
      reportProgress: (_index, written, total) => options.onProgress?.({ stage: 'write', message: `Writing ESP8266 ${written}/${total} compressed bytes`, percent: 10 + Math.round(written / total * 70) }) });
    const bytes = await loader.readFlash(0, image.length);
    if (bytes.length !== image.length || !bytes.every((value, index) => value === image[index])) throw new Error('ESP8266 byte-for-byte flash readback mismatch');
    options.onProgress?.({ stage: 'verify', message: `Verified ${image.length} firmware bytes`, percent: 95 });
    await transport.setSignals(false, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await transport.setSignals(false, false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { ok: true, chip: 'ESP8266', mac, crystalMHz, flashId, flashSize: '4MB', flashWrite: { ok: true, addresses: [0], bytes: image.length }, readback: { verified: true, bytes: image.length, matched: true }, reboot: { requested: true, confirmed: false } };
  } finally { await transport.disconnect(); }
};
