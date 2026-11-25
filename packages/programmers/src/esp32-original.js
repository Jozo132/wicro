import { ESPLoader } from 'esptool-js';
import { validateEsp32OriginalImage } from '../../runtime/src/esp32-original-image.js';

/** Read-only interpretation of ESP32 BLK0 eFuses; never changes security state.
 * @param {number} word0 @param {number} word6
 */
export const validateEsp32OriginalSecurity = (word0, word6) => {
  let encrypted = 0;
  for (let bits = (word0 >>> 20) & 127; bits; bits >>>= 1) encrypted ^= bits & 1;
  if (encrypted || (word6 & 0x30)) throw new Error('This bare-metal boot recipe requires flash encryption and secure boot disabled');
};

/** Shared Node/Web Serial uploader for the 4 MiB RAM-only original ESP32 board profile.
 * @param {any} transport @param {Uint8Array} image
 * @param {{expectedMac?:string,onLog?:(message:string)=>void,onProgress?:(event:{stage:string,message:string,percent:number})=>void}} [options]
 */
export const flashEsp32Original = async (transport, image, options = {}) => {
  validateEsp32OriginalImage(image);
  if (image.length > 0x7000) throw new Error('This original ESP32 profile requires a ROM image that ends before the partition table at 0x8000');
  const log = (/** @type {string} */ message) => options.onLog?.(message.trimEnd());
  const loader = new ESPLoader({ transport, baudrate: 115200, romBaudrate: 115200, terminal: { clean: () => {}, writeLine: log, write: log } });
  try {
    options.onProgress?.({ stage: 'connect', message: 'Entering original ESP32 ROM through DTR/RTS', percent: 5 });
    await loader.detectChip('default_reset', 7);
    if (loader.chip.CHIP_NAME !== 'ESP32') throw new Error('Expected original ESP32 LX6; other Espressif targets require a separate recipe');
    const efuse0 = await loader.readReg(0x3ff5a000), efuse6 = await loader.readReg(0x3ff5a018);
    validateEsp32OriginalSecurity(efuse0, efuse6);
    const mac = await loader.chip.readMac(loader);
    if (options.expectedMac && mac.toLowerCase() !== options.expectedMac.toLowerCase()) throw new Error('Connected original ESP32 MAC does not match the selected hardware target');
    const crystalMHz = await loader.chip.getCrystalFreq(loader);
    if (crystalMHz !== 40) throw new Error('This early-ROM UART firmware profile requires a detected 40 MHz crystal');
    await loader.runStub();
    const flashId = await loader.readFlashId();
    const capacity = 2 ** (flashId >>> 16 & 255);
    if (capacity !== 4194304) throw new Error(`This firmware profile requires detected 4 MiB flash; JEDEC=0x${flashId.toString(16)}`);
    await loader.writeFlash({ fileArray: [{ address: 0x1000, data: image }], flashMode: 'keep', flashFreq: 'keep', flashSize: 'keep', eraseAll: false, compress: true,
      reportProgress: (_index, written, total) => options.onProgress?.({ stage: 'write', message: `Writing original ESP32 ${written}/${total} compressed bytes`, percent: 10 + Math.round(written / total * 70) }) });
    const bytes = await loader.readFlash(0x1000, image.length);
    if (bytes.length !== image.length || !bytes.every((value, index) => value === image[index])) throw new Error('original ESP32 byte-for-byte flash readback mismatch');
    options.onProgress?.({ stage: 'verify', message: `Verified ${image.length} firmware bytes`, percent: 95 });
    await transport.setSignals(false, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await transport.setSignals(false, false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { ok: true, chip: 'ESP32', mac, crystalMHz, flashId, flashSize: '4MB', flashWrite: { ok: true, addresses: [0x1000], bytes: image.length }, readback: { verified: true, bytes: image.length, matched: true }, reboot: { requested: true, confirmed: false } };
  } finally { await transport.disconnect(); }
};
