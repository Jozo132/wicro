export const NANO_LINKER_SCRIPT = `ENTRY(__vectors)
MEMORY { text (rx) : ORIGIN = 0, LENGTH = 30720
 data (rw) : ORIGIN = 0x800100, LENGTH = 2048 }
SECTIONS {
 .text : { KEEP(*(.vectors)) *(.progmem*) . = ALIGN(2); *(.trampolines*) *(.lowtext*) __ctors_start = .; KEEP(*(.ctors .ctors.*)) KEEP(*(.init_array .init_array.*)) __ctors_end = .; __dtors_start = .; KEEP(*(.dtors .dtors.*)) __dtors_end = .; KEEP(*(.init0)) KEEP(*(.init1)) KEEP(*(.init2)) KEEP(*(.init3)) KEEP(*(.init4)) KEEP(*(.init5)) KEEP(*(.init6)) KEEP(*(.init7)) KEEP(*(.init8)) KEEP(*(.init9)) *(.text .text.*) *(.fini*) . = ALIGN(2); _etext = .; } >text
 .data : { __data_start = .; *(.data .data.*) *(.rodata .rodata.*) . = ALIGN(2); __data_end = .; } >data AT>text
 __data_load_start = LOADADDR(.data); __data_load_end = LOADADDR(.data)+SIZEOF(.data);
 .bss (NOLOAD) : { __bss_start = .; *(.bss .bss.*) *(COMMON) __bss_end = .; } >data
 .noinit (NOLOAD) : { *(.noinit*) __heap_start = .; } >data
 __stack = 0x8ff;
 PROVIDE(_Z11serialEventv = 0);
 /DISCARD/ : { *(.comment) *(.note*) *(.debug*) *(.stab*) }
}`;

/** @type {import('./registry.js').PlatformAdapter} */
export const nanoArduinoPlatformAdapter = Object.freeze({
  id: 'arduino-nano-avr', family: 'avr', architectures: Object.freeze(['avr']), frameworks: Object.freeze(['arduino']),
  defaultFirmwareFormat: 'avr-bin', programmerId: 'nano-stk500v1',
  matchesBoard: (board) => board.metadata.platform === 'arduino-nano-avr',
  async resolveCompileConfig({ host, projectManifest }) {
    const root = host.sdkCacheDirectory;
    if (!root) throw new Error('Nano Arduino SDK is required; run scripts/package-nano-sdk.js and supply its verified distribution');
    const names = JSON.parse(String(await host.readFile(`${root}/sources.json`, { encoding: 'utf8' })));
    /** @type {Array<{name:string,source:string,language:'c'|'c++'}>} */
    const extraUnits = [];
    for (const name of names) {
      const source = await host.readFile(`${root}/core/${name}`, { encoding: 'utf8' });
      if (typeof source !== 'string') throw new Error(`Missing Arduino core source ${name}`);
      extraUnits.push({ name: `${name}.o`, source, language: name.endsWith('.cpp') ? 'c++' : 'c' });
    }
    const build = /** @type {{flags?:string[],defines?:string[]}} */ (projectManifest.build ?? {});
    return {
      compilerFlags: ['-std=gnu++11', '-Os', '-ffunction-sections', '-fdata-sections', '-fno-builtin', '-Wno-unknown-attributes', '-fno-exceptions', '-fno-rtti', '-fno-threadsafe-statics', ...(build.flags ?? [])],
      defines: ['F_CPU=16000000L', 'ARDUINO=10819', 'ARDUINO_AVR_NANO', 'ARDUINO_ARCH_AVR', ...(build.defines ?? [])],
      includeDirs: ['/sdk/core', '/sdk/variant', '/sdk/avr/include', '/sdk/gcc/include'], preopens: { '/sdk': root }, extraUnits
    };
  },
  async prepareLinkPlan({ host, compiledObjects }) {
    const root = host.sdkCacheDirectory;
    if (!root) throw new Error('Nano Arduino SDK is missing');
    const crt = await host.readFile(`${root}/lib/crtatmega328p.o`, { encoding: 'binary' });
    if (!(crt instanceof Uint8Array)) throw new Error('Genuine AVR C runtime startup is required');
    return { preObjects: { 'crt.o': crt }, objects: compiledObjects, preopens: { '/sdk': root },
      archivePaths: ['libatmega328p.a', 'libc.a', 'libm.a', 'libgcc.a'].map((name) => `/sdk/lib/${name}`),
      linkerScripts: { 'nano.ld': NANO_LINKER_SCRIPT }, entry: '__vectors', firmwareFormat: 'avr-bin' };
  }
});
