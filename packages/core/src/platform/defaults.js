import { rp2040ZeroPlatformAdapter } from './rp2040.js';
import { esp32OriginalBareMetalPlatformAdapter } from './esp32-original.js';
import { nanoArduinoPlatformAdapter } from './nano.js';
import { esp8266BareMetalPlatformAdapter } from './esp8266.js';
import { WicroPlatformRegistry } from './registry.js';
import { BUILTIN_ARCHITECTURES } from './architectures.js';
import { BUILTIN_FRAMEWORKS } from './frameworks.js';
import { BUILTIN_FIRMWARE_FORMATS } from './formats.js';
import { esp32C3PlatformAdapter } from './esp32.js';
import { stm32BareMetalPlatformAdapter } from './stm32.js';
import { stm32F103SwdPlatformAdapter } from './stm32f103.js';

/** @type {readonly import('./registry.js').ProgrammerDescriptor[]} */
export const BUILTIN_PROGRAMMERS = Object.freeze([
  Object.freeze({ id: 'stm32f103-stlink', name: 'STM32F103 ST-Link SWD', protocols: Object.freeze(['stlink-swd']), browserProtocols: Object.freeze(['stlink-swd']), platforms: Object.freeze(['st-stm32f103-swd']) }),
  Object.freeze({ id: 'esp32-original-uart', name: 'Original ESP32 UART', protocols: Object.freeze(['esptool-slip']), browserProtocols: Object.freeze(['esptool-slip']), platforms: Object.freeze(['espressif-esp32-original-bare-metal']) }),
  Object.freeze({ id: 'rp2040-picoboot', name: 'RP2040 ROM PICOBOOT', protocols: Object.freeze(['picoboot']), browserProtocols: Object.freeze(['picoboot']), platforms: Object.freeze(['raspberrypi-rp2040-zero']) }),
  Object.freeze({ id: 'nano-stk500v1', name: 'Arduino Nano UART (STK500v1)', protocols: Object.freeze(['stk500v1']), browserProtocols: Object.freeze(['stk500v1']), platforms: Object.freeze(['arduino-nano-avr']) }),
  Object.freeze({ id: 'esp8266-uart', name: 'ESP8266 UART (esptool-js)', protocols: Object.freeze(['esptool-slip']), browserProtocols: Object.freeze(['esptool-slip']), platforms: Object.freeze(['espressif-esp8266-bare-metal']) }),
  Object.freeze({
    id: 'esp32-c3-usb-jtag',
    name: 'ESP32-C3 USB Serial/JTAG (esptool-js + CDC reset)',
    protocols: Object.freeze(['esptool-slip', 'usb-jtag-cdc']),
    browserProtocols: Object.freeze(['esptool-slip']),
    platforms: Object.freeze(['espressif-esp32c3'])
  }),
  Object.freeze({
    id: 'stm32-cdc-dfu',
    name: 'STM32 CDC trigger / USB DfuSe',
    protocols: Object.freeze(['cdc-dfu', 'dfuse']),
    browserProtocols: Object.freeze(['dfuse']),
    platforms: Object.freeze(['st-stm32-bare-metal'])
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
  registry.registerPlatform(nanoArduinoPlatformAdapter);
  registry.registerPlatform(rp2040ZeroPlatformAdapter);
  registry.registerPlatform(esp32OriginalBareMetalPlatformAdapter);
  registry.registerPlatform(esp8266BareMetalPlatformAdapter);
  registry.registerPlatform(stm32BareMetalPlatformAdapter);
  registry.registerPlatform(stm32F103SwdPlatformAdapter);
  for (const programmer of BUILTIN_PROGRAMMERS) registry.registerProgrammer(programmer);
  return registry;
};
