/** @typedef {{variant:string,mcu:string,multilib:string,ramOrigin:number,name:string,usb?:boolean}} AvrArduinoRecipe */
import { NANO_LINKER_SCRIPT } from './nano.js';

/** @type {import('./registry.js').PlatformAdapter} */
export const avrArduinoPlatformAdapter = Object.freeze({
  id: 'arduino-avr', family: 'avr', architectures: Object.freeze(['avr']), frameworks: Object.freeze(['arduino']),
  defaultFirmwareFormat: 'avr-bin',
  matchesBoard: (board) => board.metadata.platform === 'arduino-avr',
  async resolveCompileConfig({ host, board, projectManifest, project, libraryFiles }) {
    const root = host.sdkCacheDirectory;
    if (!root) throw new Error('The genuine AVR Arduino SDK is required');
    const recipe = /** @type {AvrArduinoRecipe} */ (board.metadata.avr);
    if (!recipe?.variant || !recipe.mcu || !recipe.multilib) throw new Error('Incomplete AVR board recipe');
    const inventory = /** @type {string[]} */ (JSON.parse(String(await host.readFile(`${root}/inventory.json`, { encoding: 'utf8' }))));
    const build = /** @type {{sources?:string[],flags?:string[],defines?:string[]}} */ (projectManifest.build ?? {});
    const paths = inventory.filter((path) => /^core\/[^/]+\.(c|cpp|S)$/.test(path) && (recipe.usb || !/\/(CDC|USBCore|PluggableUSB)\.cpp$/.test(path)));
    const wdt = String(await host.readFile(`${root}/avr/include/avr/wdt.h`, { encoding: 'utf8' })).replace(/"I"\s+(\(_SFR_IO_ADDR\(_WD_CONTROL_REG\)\))/g, '"n" $1');
    const includeDirs = ['compat', '/sdk/core', `/sdk/variants/${recipe.variant}`, '/sdk/avr/include', '/sdk/gcc/include'];
    let scan = '';
    for (const path of build.sources ?? ['main.ino']) scan += String(await host.readFile(`${project}/${path}`, { encoding: 'utf8' }));
    for (const bytes of Object.values(libraryFiles ?? {})) scan += '\n' + new TextDecoder().decode(bytes);
    const selected = new Set();
    for (;;) {
      let added = false;
      for (const match of scan.matchAll(/^\s*#\s*include\s*[<"]([^">]+)[">]/gm)) {
        const candidate = inventory.find((path) => path.startsWith('libraries/') && path.endsWith('/' + match[1]) && path.includes('/src/'));
        const library = candidate?.split('/')[1];
        if (!library || selected.has(library)) continue;
        selected.add(library); added = true; includeDirs.push(`/sdk/libraries/${library}/src`);
        for (const path of inventory.filter((path) => path.startsWith(`libraries/${library}/src/`))) {
          if (/\.(c|cpp|S)$/.test(path)) paths.push(path);
          if (/\.(h|hpp|c|cpp)$/.test(path)) scan += '\n' + String(await host.readFile(`${root}/${path}`, { encoding: 'utf8' }));
        }
      }
      if (!added) break;
    }
    /** @type {Array<{name:string,source:string,language:'c'|'c++'|'assembly',includeDirs:string[],compilerFlags:string[]}>} */ const extraUnits = [];
    for (const path of [...new Set(paths)].sort()) {
      const source = await host.readFile(`${root}/${path}`, { encoding: 'utf8' });
      if (typeof source !== 'string') throw new Error(`Missing AVR Arduino source ${path}`);
      extraUnits.push({ name: path.replace(/\W/g, '_') + '.o', source, language: path.endsWith('.S') ? 'assembly' : path.endsWith('.cpp') ? 'c++' : 'c', includeDirs: ['/sdk/' + path.split('/').slice(0, -1).join('/')], compilerFlags: path.endsWith('.S') ? ['-x', 'assembler-with-cpp'] : [] });
    }
    return { compilerFlags: ['-std=gnu++11', '-Os', '-ffunction-sections', '-fdata-sections', '-fno-builtin', '-Wno-unknown-attributes', '-fno-exceptions', '-fno-rtti', '-fno-threadsafe-statics', ...(build.flags ?? [])], defines: [`F_CPU=${board.clockHz}L`, 'ARDUINO=10819', `ARDUINO_AVR_${recipe.name}`, 'ARDUINO_ARCH_AVR', '__DELAY_BACKWARD_COMPATIBLE__', ...(recipe.usb ? ['USB_VID=0x2341', 'USB_PID=0x8036', 'USB_MANUFACTURER="Arduino"', 'USB_PRODUCT="Arduino Leonardo"'] : []), ...(build.defines ?? [])], includeDirs, files: { 'compat/avr/wdt.h': wdt }, preopens: { '/sdk': root }, extraUnits };
  },
  async prepareLinkPlan({ host, board, compiledObjects }) {
    const root = host.sdkCacheDirectory, recipe = /** @type {AvrArduinoRecipe} */ (board.metadata.avr);
    if (!root || !recipe?.mcu) throw new Error('AVR Arduino SDK/recipe is missing');
    const crt = await host.readFile(`${root}/lib/${recipe.multilib}/crt${recipe.mcu}.o`, { encoding: 'binary' });
    if (!(crt instanceof Uint8Array)) throw new Error('Genuine AVR startup is required');
    const script = NANO_LINKER_SCRIPT.replace('LENGTH = 30720', `LENGTH = ${board.metadata.flashCapacityBytes}`).replace('ORIGIN = 0x800100, LENGTH = 2048', `ORIGIN = ${0x800000 + Number(recipe.ramOrigin)}, LENGTH = ${board.metadata.sramCapacityBytes}`).replace('__stack = 0x8ff', `__stack = ${Number(recipe.ramOrigin) + Number(board.metadata.sramCapacityBytes) - 1}`);
    return { preObjects: { 'crt.o': crt }, objects: compiledObjects, preopens: { '/sdk': root }, archivePaths: [`lib${recipe.mcu}.a`, 'libc.a', 'libm.a', 'libgcc.a'].map((name) => `/sdk/lib/${recipe.multilib}/${name}`), linkerScripts: { 'avr.ld': script + '\nPROVIDE(_Z12serialEvent1v = 0); PROVIDE(_Z12serialEvent2v = 0); PROVIDE(_Z12serialEvent3v = 0);\n' }, entry: '__vectors', firmwareFormat: 'avr-bin' };
  }
});
