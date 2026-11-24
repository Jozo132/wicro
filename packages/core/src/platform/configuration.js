import { createDefaultPlatformRegistry } from './defaults.js';

const registry = createDefaultPlatformRegistry();
export const OPTIMIZATIONS = Object.freeze(['-O0', '-Og', '-O1', '-O2', '-O3', '-Os', '-Oz', '-Ofast']);

/** @typedef {{id:string,name:string,metadata:Record<string,any>}} ConfigurationBoard */

/** @param {unknown} value @returns {value is Record<string,any>} */
export const isConfigurationObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** @param {string} text @returns {{value:Record<string,any>|null,error:string|null}} */
export const parseProjectConfiguration = (text) => {
  try {
    const value = JSON.parse(text);
    if (!isConfigurationObject(value)) throw new Error('wicro.json must contain a JSON object.');
    return { value, error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
};

/** @param {ConfigurationBoard} board */
export const getDeviceFamily = (board) => {
  const mcu = String(board.metadata.mcu ?? board.id).toUpperCase();
  if (mcu.startsWith('ESP8266')) return 'ESP8266';
  if (mcu.startsWith('ESP32')) return 'ESP32';
  if (mcu.startsWith('STM32')) return 'STM32';
  if (mcu.startsWith('RP2040')) return 'RP2040';
  if (mcu.startsWith('RP2350')) return 'RP2350';
  return board.metadata.architecture === 'avr' ? 'AVR' : String(board.metadata.manufacturer ?? 'Other');
};

/**
 * Resolve choices from the same platform/programmer registry used by the engine.
 * Clock display describes the recipe; no generic clock override is implemented.
 * @param {ConfigurationBoard|null} board
 */
export const getTargetConfiguration = (board) => {
  const metadata = board?.metadata ?? {};
  const platform = registry.getPlatform(String(metadata.platform ?? ''));
  const programmer = platform?.programmerId ? registry.getProgrammer(platform.programmerId) : undefined;
  const browserUpload = Boolean(programmer?.browserProtocols?.length);
  return {
    frameworks: [...(platform?.frameworks ?? [String(metadata.framework ?? 'arduino'), 'bare-metal'])].filter((value, index, all) => all.indexOf(value) === index),
    programmer,
    browserUpload,
    protocol: programmer?.browserProtocols?.[0] ?? null,
    clockHz: typeof metadata.clockHz === 'number' ? metadata.clockHz : metadata.platform === 'espressif-esp32c3' ? 160000000 : null,
    architecture: String(metadata.architecture ?? metadata.build?.target ?? 'Not specified'),
    buildKind: String(metadata.build?.kind ?? 'object')
  };
};

/** @param {Record<string,any>} config @param {ConfigurationBoard[]} boards @returns {string[]} */
export const validatePlatformConfiguration = (config, boards) => {
  /** @type {string[]} */
  const issues = [];
  if (typeof config.name !== 'string' || !config.name.trim()) issues.push('Project name is required.');
  const board = boards.find((entry) => entry.id === config.board) ?? null;
  if (!board) issues.push(`Unknown board: ${String(config.board ?? '(not selected)')}.`);
  const target = getTargetConfiguration(board);
  if (board && config.framework !== undefined && !target.frameworks.includes(config.framework)) issues.push(`Framework '${String(config.framework)}' is unavailable for this board.`);
  if (config.toolchain !== undefined && config.toolchain !== 'llvm-wasm') issues.push('The browser requires the llvm-wasm toolchain.');
  if (config.build !== undefined && !isConfigurationObject(config.build)) issues.push('build must be an object.');
  if (isConfigurationObject(config.build)) {
    for (const field of ['flags', 'defines', 'sources', 'formats']) {
      if (config.build[field] !== undefined && (!Array.isArray(config.build[field]) || !config.build[field].every((/** @type {unknown} */ item) => typeof item === 'string'))) issues.push(`build.${field} must be an array of strings.`);
    }
    if (config.build.clockHz !== undefined) issues.push('CPU clock overrides have no implemented clock-control recipe; remove build.clockHz.');
  }
  if (config.upload !== undefined && !isConfigurationObject(config.upload)) issues.push('upload must be an object.');
  if (isConfigurationObject(config.upload)) {
    const upload = config.upload;
    if (upload.programmer !== undefined && upload.programmer !== 'none' && (!target.browserUpload || upload.programmer !== target.programmer?.id)) issues.push(`Programmer '${String(upload.programmer)}' is unavailable for this board in the browser.`);
    if (upload.protocol !== undefined && upload.protocol !== target.protocol) issues.push(`Upload protocol '${String(upload.protocol)}' is incompatible with this board.`);
    if (upload.verify !== undefined && !['none', 'readback'].includes(upload.verify)) issues.push('upload.verify must be none or readback.');
    if (upload.autoMonitor !== undefined && typeof upload.autoMonitor !== 'boolean') issues.push('upload.autoMonitor must be a boolean.');
    for (const field of ['baudRate', 'monitorBaudRate']) {
      if (upload[field] !== undefined && (!Number.isInteger(upload[field]) || upload[field] <= 0 || upload[field] > 2000000)) issues.push(`upload.${field} must be an integer between 1 and 2000000.`);
    }
  }
  return issues;
};

/** @param {string[]} flags @param {string} value @param {boolean} enabled */
export const toggleBuildFlag = (flags, value, enabled) => [
  ...flags.filter((flag) => flag !== value), ...(enabled ? [value] : [])
];

/** @param {string[]} flags @param {string} value */
export const setOptimization = (flags, value) => [
  ...flags.filter((flag) => !OPTIMIZATIONS.includes(flag)), ...(value ? [value] : [])
];
