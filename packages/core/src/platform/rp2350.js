/** @type {import('./registry.js').PlatformAdapter} */
export const rp2350PlatformAdapter = Object.freeze({
  id: 'raspberrypi-rp2350', family: 'rp2350', architectures: Object.freeze(['armv8m-mainline', 'riscv32']), frameworks: Object.freeze(['bare-metal']),
  defaultFirmwareFormat: 'rp2350-bin', programmerId: 'rp2350-picoboot',
  matchesBoard: (board) => board.metadata.platform === 'raspberrypi-rp2350',
  async resolveCompileConfig({ projectManifest, board }) {
    const build = /** @type {{flags?:string[],defines?:string[]}} */ (projectManifest.build ?? {});
    return { compilerFlags: ['-fintegrated-as', '-ffreestanding', '-fno-builtin', '-fno-stack-protector', '-ffunction-sections', '-fdata-sections', '-Os', ...(board.architecture === 'riscv32' ? ['-mno-relax', '-msmall-data-limit=0'] : []), ...(build.flags ?? [])], defines: build.defines ?? [], includeDirs: [] };
  },
  async prepareLinkPlan({ host, board, project, compiledObjects }) {
    const script = await host.readFile(`${project}/${board.build.linkerScript}`, { encoding: 'utf8' });
    if (typeof script !== 'string') throw new Error('RP2350 linker script is required');
    return { objects: compiledObjects, linkerScripts: { 'rp2350.ld': script }, entry: board.architecture === 'riscv32' ? '_start' : 'Reset_Handler', firmwareFormat: 'rp2350-bin' };
  }
});
