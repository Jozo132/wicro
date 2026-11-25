import { resolveStm32ArduinoCompileConfig, prepareStm32ArduinoLinkPlan } from './stm32-arduino.js';

/**
 * STM32 bare-metal platform adapter (ARM Cortex-M3/M4/M7).
 * Validates that the canonical Wicro platform API cleanly supports a second,
 * substantially different architecture (ARM Thumb bare-metal + flat BIN/HEX)
 * without any STM32-specific conditionals in the shared build engine.
 */

/** @type {import('./registry.js').PlatformAdapter} */
export const stm32BareMetalPlatformAdapter = Object.freeze({
  id: 'st-stm32-bare-metal',
  family: 'stm32',
  architectures: Object.freeze(['armv7-m', 'armv7e-m']),
  frameworks: Object.freeze(['bare-metal', 'arduino']),
  defaultFirmwareFormat: 'bin',
  programmerId: 'stm32-stlink',

  matchesBoard(board) {
    return (
      board.build.kind === 'bare-metal' &&
      (board.architecture === 'armv7-m' || board.architecture === 'armv7e-m' || /^stm32/i.test(board.mcu))
    );
  },

  async resolveCompileConfig(context) {
    const { host, board, project, projectManifest, sdk } = context;
    if (board.framework === 'arduino' && board.metadata.arduino) return resolveStm32ArduinoCompileConfig(context);
    const buildSection = /** @type {{flags?:string[],defines?:string[]}|undefined} */ (projectManifest.build);
    const extraFlags = Array.isArray(buildSection?.flags) ? buildSection.flags : [];
    const extraDefines = Array.isArray(buildSection?.defines) ? buildSection.defines : [];

    /** @type {Array<{name:string,source:string,language:'c'|'c++'|'assembly'}>} */
    const extraUnits = [];
    if (board.build.startupSource) {
      const startupText = await host.readFile(`${project}/${board.build.startupSource}`, { encoding: 'utf8' });
      if (typeof startupText !== 'string') {
        throw new Error(`Startup source for '${board.id}' must be a text file: ${board.build.startupSource}`);
      }
      extraUnits.push({ name: 'startup.o', source: startupText, language: 'c' });
    }

    return {
      compilerFlags: ['-ffreestanding', '-Os', '-ffunction-sections', '-fdata-sections', ...extraFlags],
      includeDirs: [...sdk.includeDirs],
      defines: [`F_CPU=${board.clockHz}L`, ...extraDefines],
      files: sdk.files,
      extraUnits
    };
  },

  async prepareLinkPlan(context) {
    const { host, board, project, compiledObjects } = context;
    if (board.framework === 'arduino' && board.metadata.arduino) return prepareStm32ArduinoLinkPlan(context);
    if (!board.build.linkerScript) {
      throw new Error(`Board '${board.id}' has an incomplete bare-metal build recipe: missing linkerScript`);
    }
    const linkerText = await host.readFile(`${project}/${board.build.linkerScript}`, { encoding: 'utf8' });
    if (typeof linkerText !== 'string') {
      throw new Error(`Linker script for '${board.id}' must be a text file: ${board.build.linkerScript}`);
    }

    return {
      objects: compiledObjects,
      linkerScripts: { 'firmware.ld': linkerText },
      extraLinkerArgs: ['-nostdlib'],
      firmwareFormat: board.build.firmwareFormat ?? 'bin'
    };
  }
});
