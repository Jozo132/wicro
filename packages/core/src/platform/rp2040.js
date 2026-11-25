/** @type {import('./registry.js').PlatformAdapter} */
export const rp2040ZeroPlatformAdapter = Object.freeze({
  id: 'raspberrypi-rp2040-zero', family: 'rp2040', architectures: Object.freeze(['armv6m']), frameworks: Object.freeze(['bare-metal']),
  defaultFirmwareFormat: 'rp2040-bin', programmerId: 'rp2040-picoboot',
  matchesBoard: (board) => board.metadata.platform === 'raspberrypi-rp2040-zero',
  async resolveCompileConfig({ host, board, project, projectManifest }) {
    const source = await host.readFile(`${project}/${board.build.startupSource}`, { encoding: 'utf8' });
    if (typeof source !== 'string') throw new Error('RP2040 boot2 assembly source is required');
    const build = /** @type {{flags?:string[],defines?:string[]}} */ (projectManifest.build ?? {});
    return { compilerFlags: ['-fintegrated-as', '-ffreestanding', '-fno-builtin', '-ffunction-sections', '-fdata-sections', '-Os', ...(build.flags ?? [])], defines: build.defines ?? [], includeDirs: [], extraUnits: [{ name: 'boot2.o', source, language: 'assembly' }] };
  },
  async prepareLinkPlan({ host, board, project, compiledObjects }) {
    const script = await host.readFile(`${project}/${board.build.linkerScript}`, { encoding: 'utf8' });
    if (typeof script !== 'string') throw new Error('RP2040 linker script is required');
    return { objects: compiledObjects, linkerScripts: { 'rp2040.ld': script }, entry: 'Reset_Handler', firmwareFormat: 'rp2040-bin' };
  }
});
