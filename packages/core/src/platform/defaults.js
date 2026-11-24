import { WicroPlatformRegistry } from './registry.js';
import { BUILTIN_ARCHITECTURES } from './architectures.js';
import { BUILTIN_FRAMEWORKS } from './frameworks.js';
import { BUILTIN_FIRMWARE_FORMATS } from './formats.js';
import { esp32C3PlatformAdapter } from './esp32.js';
import { stm32BareMetalPlatformAdapter } from './stm32.js';

/** @type {readonly import('./registry.js').ProgrammerDescriptor[]} */
export const BUILTIN_PROGRAMMERS = Object.freeze([
  Object.freeze({
    id: 'esp32-c3-usb-jtag',
    name: 'ESP32-C3 USB Serial/JTAG (esptool-js + CDC reset)',
    protocols: Object.freeze(['esptool-slip', 'usb-jtag-cdc']),
    browserProtocols: Object.freeze(['esptool-slip']),
    platforms: Object.freeze(['espressif-esp32c3'])
  }),
  Object.freeze({
    id: 'stm32-stlink',
    name: 'STM32 ST-LINK / UART / DFU',
    protocols: Object.freeze(['stlink', 'stm32-uart', 'dfu']),
    platforms: Object.freeze(['st-stm32-bare-metal'])
  })
]);

/**
 * Create a WicroPlatformRegistry pre-populated with all built-in architectures,
 * frameworks, firmware formats, platforms, and programmer descriptors.
 */
export const createDefaultPlatformRegistry = () => {
  const registry = new WicroPlatformRegistry();
  for (const architecture of BUILTIN_ARCHITECTURES) registry.registerArchitecture(architecture);
  for (const framework of BUILTIN_FRAMEWORKS) registry.registerFramework(framework);
  for (const format of BUILTIN_FIRMWARE_FORMATS) registry.registerFirmwareFormat(format);
  registry.registerPlatform(esp32C3PlatformAdapter);
  registry.registerPlatform(stm32BareMetalPlatformAdapter);
  for (const programmer of BUILTIN_PROGRAMMERS) registry.registerProgrammer(programmer);
  return registry;
};
