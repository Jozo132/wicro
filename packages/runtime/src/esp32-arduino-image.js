import { elfToEsp32Bin, validateEsp32Image } from './elf-utils.js';

/** Explicit Espressif image/memory identities, independent of instruction-set selection.
 * @type {Record<string,{machine:number,chipId:number,mappedRanges:number[][],entryRanges:number[][]}>}
 */
export const ESP32_IMAGE_PROFILES = Object.freeze({
  esp32: { machine:94,chipId:0,mappedRanges:[[0x3f400000,0x3f800000],[0x400d0000,0x40400000]],entryRanges:[[0x40080000,0x400c0000]] },
  esp32s2: { machine:94,chipId:2,mappedRanges:[[0x3f000000,0x3f3f0000],[0x40080000,0x40b80000]],entryRanges:[[0x40020000,0x40080000]] },
  esp32s3: { machine:94,chipId:9,mappedRanges:[[0x3c000000,0x3e000000],[0x42000000,0x44000000]],entryRanges:[[0x40370000,0x40400000]] },
  esp32c6: { machine:243,chipId:13,mappedRanges:[[0x42000000,0x42800000]],entryRanges:[[0x40800000,0x40880000]] },
  esp32h2: { machine:243,chipId:16,mappedRanges:[[0x42000000,0x42800000]],entryRanges:[[0x40800000,0x40880000]] }
});
/** @param {Uint8Array} elf @param {string} chip */
export const elfToEsp32ArduinoBin = async (elf,chip) => {
  const profile=ESP32_IMAGE_PROFILES[chip];if(!profile)throw new Error(`Unsupported Espressif image target ${chip}`);
  const bytes=await elfToEsp32Bin(elf,profile),validation=await validateEsp32Image(bytes,profile);
  if(!validation.valid)throw new Error(validation.errors.join('; '));return bytes;
};
/** @param {Uint8Array} bytes @param {string} chip */
export const validateEsp32ArduinoImage = async (bytes,chip) => {
  const profile=ESP32_IMAGE_PROFILES[chip];if(!profile)throw new Error(`Unsupported Espressif image target ${chip}`);
  return validateEsp32Image(bytes,profile);
};
