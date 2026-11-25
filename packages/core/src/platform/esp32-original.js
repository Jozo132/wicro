/** Bare-metal RAM-only Original ESP32 firmware; Arduino remains a separate SDK recipe. */
/** @type {import('./registry.js').PlatformAdapter} */
export const esp32OriginalBareMetalPlatformAdapter = Object.freeze({
  id: 'espressif-esp32-original-bare-metal', family: 'esp32', architectures: Object.freeze(['xtensa']),
  frameworks: Object.freeze(['bare-metal']), defaultFirmwareFormat: 'esp32-original-rom', programmerId: 'esp32-original-uart',
  matchesBoard: (board) => board.metadata.platform === 'espressif-esp32-original-bare-metal',
  async resolveCompileConfig({ host, board, project, projectManifest, sdk }) {
    if (!board.build.startupSource) throw new Error('Original ESP32 startup source is required');
    const source = await host.readFile(`${project}/${board.build.startupSource}`, { encoding: 'utf8' });
    if (typeof source !== 'string') throw new Error('Original ESP32 startup must be text');
    const build = /** @type {{flags?:string[],defines?:string[]}} */ (projectManifest.build ?? {});
    return {
      compilerFlags: ['-fintegrated-as', '-ffreestanding', '-fno-builtin', '-ffunction-sections', '-fdata-sections', '-Os', ...(build.flags ?? [])],
      defines: [...(build.defines ?? [])], includeDirs: [...sdk.includeDirs], files: sdk.files,
      extraUnits: [{ name: 'startup.o', source, language: 'assembly' }]
    };
  },
  async prepareLinkPlan({ host, board, project, compiledObjects }) {
    if (!board.build.linkerScript) throw new Error('Original ESP32 linker script is required');
    const script = await host.readFile(`${project}/${board.build.linkerScript}`, { encoding: 'utf8' });
    if (typeof script !== 'string') throw new Error('Original ESP32 linker script must be text');
    return { objects: compiledObjects, linkerScripts: { 'esp32.ld': script }, entry: '_start', extraLinkerArgs: ['-nostdlib'], firmwareFormat: 'esp32-original-rom' };
  }
});
