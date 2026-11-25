/** Bare-metal RAM-only ESP8266 firmware; Arduino remains a separate SDK recipe. */
/** @type {import('./registry.js').PlatformAdapter} */
export const esp8266BareMetalPlatformAdapter = Object.freeze({
  id: 'espressif-esp8266-bare-metal', family: 'esp8266', architectures: Object.freeze(['xtensa']),
  frameworks: Object.freeze(['bare-metal']), defaultFirmwareFormat: 'esp8266-rom', programmerId: 'esp8266-uart',
  matchesBoard: (board) => board.metadata.platform === 'espressif-esp8266-bare-metal',
  async resolveCompileConfig({ host, board, project, projectManifest, sdk }) {
    if (!board.build.startupSource) throw new Error('ESP8266 startup source is required');
    const source = await host.readFile(`${project}/${board.build.startupSource}`, { encoding: 'utf8' });
    if (typeof source !== 'string') throw new Error('ESP8266 startup must be text');
    const build = /** @type {{flags?:string[],defines?:string[]}} */ (projectManifest.build ?? {});
    return {
      compilerFlags: ['-fintegrated-as', '-ffreestanding', '-fno-builtin', '-ffunction-sections', '-fdata-sections', '-Os', ...(build.flags ?? [])],
      defines: [...(build.defines ?? [])], includeDirs: [...sdk.includeDirs], files: sdk.files,
      extraUnits: [{ name: 'startup.o', source, language: 'assembly' }]
    };
  },
  async prepareLinkPlan({ host, board, project, compiledObjects }) {
    if (!board.build.linkerScript) throw new Error('ESP8266 linker script is required');
    const script = await host.readFile(`${project}/${board.build.linkerScript}`, { encoding: 'utf8' });
    if (typeof script !== 'string') throw new Error('ESP8266 linker script must be text');
    return { objects: compiledObjects, linkerScripts: { 'esp8266.ld': script }, entry: '_start', extraLinkerArgs: ['-nostdlib'], firmwareFormat: 'esp8266-rom' };
  }
});
