/** @typedef {{series:string,productLine:string,variant:string,board:string,startup:string,multilib:string,usb?:boolean,led?:string,fpu?:string,ramRegion?:string,usbHighSpeedInFullSpeed?:boolean}} Stm32ArduinoRecipe */

/** @param {import('../index.js').WicroHostAdapter} host @param {string} root @param {string} path */
const readText = async (host, root, path) => {
  const source = await host.readFile(`${root}/${path}`, { encoding: 'utf8' });
  if (typeof source !== 'string') throw new Error(`STM32 SDK source is missing: ${path}`);
  return source;
};

/** @type {import('./registry.js').PlatformAdapter['resolveCompileConfig']} */
export const resolveStm32ArduinoCompileConfig = async ({ host, board, project, projectManifest, libraryFiles }) => {
  const root = host.sdkCacheDirectory;
  if (!root) throw new Error('STM32 Arduino requires the verified family SDK');
  const recipe = /** @type {Stm32ArduinoRecipe} */ (board.metadata.arduino);
  if (!recipe?.series || !recipe.variant || !recipe.startup || !recipe.multilib) throw new Error('Incomplete STM32 Arduino board recipe');
  const inventory = /** @type {string[]} */ (JSON.parse(await readText(host, root, 'inventory.json')));
  const sources = /** @type {string[]} */ (JSON.parse(await readText(host, root, 'sources.json')));
  const variant = `framework/variants/${recipe.variant}`;
  sources.push(...inventory.filter((path) => path.startsWith(variant + '/') && /\.(c|cpp)$/.test(path)));
  const includeDirs = [
    '/sdk/clang/include', '/sdk/gcc/include', '/sdk/gcc/include-fixed', '/sdk/framework/cores/arduino', '/sdk/framework/cores/arduino/avr', '/sdk/framework/cores/arduino/stm32', '/sdk/framework/cores/arduino/api/deprecated',
    ...['SrcWrapper/inc', 'SrcWrapper/inc/LL', 'USBDevice/inc', 'VirtIO/inc'].map((path) => `/sdk/framework/libraries/${path}`),
    `/sdk/framework/system/Drivers/${recipe.series}_HAL_Driver/Inc`, `/sdk/framework/system/Drivers/${recipe.series}_HAL_Driver/Src`, `/sdk/framework/system/${recipe.series}`,
    '/sdk/framework/system/Middlewares/ST/STM32_USB_Device_Library/Core/Inc', '/sdk/framework/system/Middlewares/ST/STM32_USB_Device_Library/Core/Src',
    `/sdk/framework/system/Drivers/CMSIS/Device/ST/${recipe.series}/Include`, '/sdk/cmsis/Core/Include', '/sdk/cmsis/DSP/Include', `/sdk/${variant}`,
    '/sdk/sysroot/include/c++/12.3.1', `/sdk/sysroot/include/c++/12.3.1/arm-none-eabi/thumb/${recipe.multilib}`, '/sdk/sysroot/include/c++/12.3.1/arm-none-eabi', '/sdk/sysroot/include/c++/12.3.1/backward', '/sdk/sysroot/include'
  ];
  const build = /** @type {{sources?:string[],flags?:string[],defines?:string[]}} */ (projectManifest.build ?? {});
  let scan = '';
  for (const path of build.sources ?? [board.build.source ?? 'main.ino']) scan += await readText(host, project, path);
  for (const bytes of Object.values(libraryFiles ?? {})) scan += '\n' + new TextDecoder().decode(bytes);
  const selectedLibraries = new Set(['SrcWrapper', 'USBDevice', 'VirtIO']);
  // Resolve bundled libraries from actual include directives, recursively including
  // their sources/headers; never compile unrelated board-specific libraries blindly.
  for (;;) {
    let added = false;
    const includes = [...scan.matchAll(/^\s*#\s*include\s*[<"]([^">]+)[">]/gm)].map((match) => match[1]);
    for (const name of includes) {
      const candidate = inventory.find((path) => path.startsWith('framework/libraries/') && path.endsWith('/' + name) && !path.includes('/examples/') && !path.includes('/test/'));
      if (!candidate) continue;
      const library = candidate.split('/')[2];
      if (selectedLibraries.has(library)) continue;
      selectedLibraries.add(library); added = true;
      const prefix = `framework/libraries/${library}/`;
      const members = inventory.filter((path) => path.startsWith(prefix) && !path.includes('/examples/') && !path.includes('/test/'));
      for (const path of members) {
        if (/\.(c|cpp)$/.test(path)) sources.push(path);
        if (/\.(c|cpp|h|hpp)$/.test(path)) scan += '\n' + await readText(host, root, path);
      }
      includeDirs.push(`/sdk/${prefix}src`, `/sdk/${prefix.slice(0, -1)}`);
    }
    if (!added) break;
  }
  /** @type {Array<{name:string,source:string,language:'c'|'c++'|'assembly',includeDirs?:string[]}>} */
  const extraUnits = [];
  for (const path of [...new Set(sources)].sort()) extraUnits.push({ name: path.replace(/[^a-zA-Z0-9_.-]/g, '_') + '.o', source: await readText(host, root, path), language: /** @type {'c'|'c++'} */ (path.endsWith('.cpp') ? 'c++' : 'c'), includeDirs: ['/sdk/' + path.split('/').slice(0, -1).join('/')] });
  extraUnits.push({ name: 'stm32-startup.o', source: await readText(host, root, `framework/system/Drivers/CMSIS/Device/ST/${recipe.series}/Source/Templates/gcc/${recipe.startup}`), language: /** @type {'assembly'} */ ('assembly') });
  const usb = recipe.usb !== false;
  return { compilerFlags: ['-std=gnu++17', '-ffreestanding', '-fno-builtin', '-Os', '-ffunction-sections', '-fdata-sections', '-fno-threadsafe-statics', '-fno-rtti', '-fno-exceptions', '-fno-use-cxa-atexit', '-Wno-unknown-attributes', '-Wno-ignored-attributes', ...(recipe.fpu || recipe.series === 'STM32F4xx' ? [`-mfpu=${recipe.fpu ?? 'fpv4-sp-d16'}`, '-mfloat-abi=hard'] : []), ...(build.flags ?? [])],
    defines: [recipe.series, recipe.productLine, 'ARDUINO=10808', 'ARDUINO_ARCH_STM32', `ARDUINO_${recipe.board}`, 'VARIANT_H="variant_generic.h"', `BOARD_NAME="Wicro ${board.mcu}"`, `F_CPU=${board.clockHz}L`, 'USE_HAL_DRIVER', 'USE_FULL_LL_DRIVER', 'HAL_UART_MODULE_ENABLED', 'EXTENDED_PIN_MODE', 'NDEBUG', 'GCC_VERSION=120301', ...(recipe.led ? [`LED_BUILTIN=${recipe.led}`] : []), ...(recipe.usbHighSpeedInFullSpeed ? ['USE_USB_HS', 'USE_USB_HS_IN_FS'] : []), ...(usb ? ['USBCON', 'USBD_USE_CDC', 'PIO_FRAMEWORK_ARDUINO_ENABLE_CDC', 'HAL_PCD_MODULE_ENABLED', 'USB_VID=0x0483', 'USB_PID=0x5740'] : []), ...(build.defines ?? [])], includeDirs, extraUnits, preopens: { '/sdk': root }
  };
};

/** @type {import('./registry.js').PlatformAdapter['prepareLinkPlan']} */
export const prepareStm32ArduinoLinkPlan = async ({ host, board, compiledObjects }) => {
  const root = host.sdkCacheDirectory;
  if (!root) throw new Error('STM32 Arduino SDK is missing');
  const recipe = /** @type {Stm32ArduinoRecipe} */ (board.metadata.arduino);
  let script = await readText(host, root, `framework/variants/${recipe.variant}/ldscript.ld`);
  script = script.replace(/\(READONLY\)/g, '').replace(/\bLD_MAX_DATA_SIZE\b/g, String(board.metadata.sramCapacityBytes)).replace(/\bLD_MAX_SIZE\b/g, String(board.metadata.flashCapacityBytes)).replace(/\bLD_FLASH_OFFSET\b/g, '0');
  const ramBase = Number(board.metadata.sramAddress ?? '0x20000000');
  script = script.replace(/_estack\s*=\s*ORIGIN\(\w+\)\s*\+\s*LENGTH\(\w+\);/, `_estack = 0x${(ramBase + Number(board.metadata.sramCapacityBytes)).toString(16)};`);
  script = script.replace(/  \.\_user_heap_stack/, '  .noinit (NOLOAD) : { . = ALIGN(32); *(.noinit .noinit*) . = ALIGN(4); } >' + (recipe.ramRegion ?? 'RAM') + '\n  ._user_heap_stack');
  script = script.replace(/\.bss\s*:/, '.bss (NOLOAD) :').replace(/\._user_heap_stack\s*:/, '._user_heap_stack (NOLOAD) :');
  const crti = await host.readFile(`${root}/lib/crti.o`, { encoding: 'binary' }), crtn = await host.readFile(`${root}/lib/crtn.o`, { encoding: 'binary' });
  if (!(crti instanceof Uint8Array) || !(crtn instanceof Uint8Array)) throw new Error('STM32 target CRT data is missing');
  return { preObjects: { 'crti.o': crti }, objects: { ...compiledObjects, 'crtn.o': crtn }, preopens: { '/sdk': root }, archivePaths: ['libc_nano.a', 'libm.a', 'libstdc++_nano.a', 'libgcc.a'].map((name) => `/sdk/lib/${name}`), linkerScripts: { 'stm32-arduino.ld': script }, entry: 'Reset_Handler', firmwareFormat: 'bin' };
};
