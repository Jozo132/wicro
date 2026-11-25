import { resolveSdkSourceIncludes } from './sdk-source.js';
/** @typedef {{chip:string,variant:string,boot2?:string,sdkBoard?:string,wifi?:boolean}} PicoArduinoRecipe */
/** @param {import('../index.js').WicroHostAdapter} host @param {string} root @param {string} path */
const text = async (host, root, path) => {
  const source = await host.readFile(`${root}/${path}`, { encoding: 'utf8' });
  if (typeof source !== 'string') throw new Error(`Missing genuine Pico SDK input ${path}`);
  return source;
};
/** Parse trusted upstream response files without invoking their native driver.
 * @param {string} value
 */
const words = (value) => value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));

/** @type {import('./registry.js').PlatformAdapter} */
export const picoArduinoPlatformAdapter = Object.freeze({
  id: 'raspberrypi-arduino-pico', family: 'rp2', architectures: Object.freeze(['armv6m', 'armv8m-mainline', 'riscv32']), frameworks: Object.freeze(['arduino']),
  defaultFirmwareFormat: 'bin',
  matchesBoard: (board) => board.metadata.platform === 'raspberrypi-arduino-pico',
  async resolveCompileConfig({ host, board, project, projectManifest, libraryFiles }) {
    const root = host.sdkCacheDirectory, recipe = /** @type {PicoArduinoRecipe} */ (board.metadata.picoArduino);
    if (!root || !recipe?.chip || !recipe.variant) throw new Error('Genuine Arduino-Pico SDK and board recipe required');
    const chip = String(recipe.chip), framework = 'framework', core = 'framework/cores/rp2040';
    const inventory = /** @type {string[]} */ (JSON.parse(await text(host, root, 'inventory.json')));
    const includeText = await text(host, root, `${framework}/lib/core_inc.txt`) + '\n' + await text(host, root, `${framework}/lib/${chip}/platform_inc.txt`);
    const multilib = chip.endsWith('riscv') ? 'rv32imac/ilp32' : chip === 'rp2040' ? 'thumb' : 'thumb/autofp/v7/fpu';
    const includeDirs = ['compat', '/sdk/clang/include', `/sdk/${core}`, `/sdk/${framework}/variants/${recipe.variant}`, '/sdk/sysroot/include/c++/16.1.0', `/sdk/sysroot/include/c++/16.1.0/${chip.endsWith('riscv') ? 'riscv32-unknown-elf' : 'arm-none-eabi'}/${multilib}`, '/sdk/sysroot/include', '/sdk/gcc/include', `/sdk/${framework}/include`, ...words(includeText).map((line) => '/sdk/' + framework + line.replace('-iwithprefixbefore', ''))];
    const defines = [...words(await text(host, root, `${framework}/lib/platform_def.txt`)), ...words(await text(host, root, `${framework}/lib/${chip}/platform_def.txt`))].map((line) => line.replace(/^-D/, ''));
    const build = /** @type {{sources?:string[],flags?:string[],defines?:string[]}} */ (projectManifest.build ?? {});
    let scan = '';
    for (const path of build.sources ?? ['main.ino']) scan += await text(host, project, path);
    for (const bytes of Object.values(libraryFiles ?? {})) scan += '\n' + new TextDecoder().decode(bytes);
    const paths = inventory.filter((path) => path.startsWith(core + '/') && /\.(c|cpp|S)$/.test(path));
    const selected = new Set();
    for (;;) {
      let added = false;
      for (const match of scan.matchAll(/^\s*#\s*include\s*[<"]([^">]+)[">]/gm)) {
        const candidate = inventory.find((path) => path.startsWith('framework/libraries/') && path.endsWith('/' + match[1]) && (path.includes('/src/') || path.split('/').length === 4));
        const library = candidate?.split('/')[2];
        if (!library || selected.has(library)) continue;
        selected.add(library); added = true;
        includeDirs.push(`/sdk/framework/libraries/${library}/src`, `/sdk/framework/libraries/${library}`);
        for (const path of inventory.filter((path) => path.startsWith(`framework/libraries/${library}/`) && !/\/(examples|tests?)\//.test(path))) {
          if (/\.(c|cpp|S)$/.test(path)) paths.push(path);
          if (/\.(c|cpp|h|hpp)$/.test(path)) scan += '\n' + await text(host, root, path);
        }
      }
      if (!added) break;
    }
    if (chip === 'rp2040') paths.push(`framework/boot2/${chip}/${recipe.boot2 ?? 'boot2_generic_03h_2_padded_checksum'}.S`);
    /** @type {Array<{name:string,source:string,language:'c'|'c++'|'assembly',includeDirs:string[],compilerFlags:string[]}>} */ const extraUnits = [];
    for (const path of [...new Set(paths)].sort()) extraUnits.push({ name: path.replace(/\W/g, '_') + '.o', source: resolveSdkSourceIncludes(await text(host, root, path), path, new Set(inventory)).replace(/^\s*\.end\s+__gnu_mcount_nc\s*$/gm, '').replace('.section .time_critical', '.section .time_critical,"ax",%progbits'), language: path.endsWith('.S') ? 'assembly' : path.endsWith('.cpp') ? 'c++' : 'c', includeDirs: ['/sdk/' + path.split('/').slice(0, -1).join('/')], compilerFlags: path.endsWith('.S') ? ['-x', 'assembler-with-cpp'] : [] });
    const boardHeader = chip === 'rp2040' ? 'pico' : 'pico2';
    const config = `#include "boards/${recipe.sdkBoard ?? boardHeader}.h"\n` + (chip.endsWith('riscv') ? '' : '#include "cmsis/rename_exceptions.h"\n');
    return { compilerFlags: ['-std=gnu++23', '-fintegrated-as', '-Os', '-ffunction-sections', '-fdata-sections', '-fno-builtin', '-fno-rtti', '-fexceptions', '-fno-threadsafe-statics', '-Wno-inconsistent-missing-override', '-Wno-unknown-attributes', '-Wno-ignored-attributes', ...(chip === 'rp2350' ? ['-mfloat-abi=softfp', '-mfpu=fpv5-sp-d16', '-mcmse'] : []), ...(chip.endsWith('riscv') ? ['-mno-relax'] : []), ...(build.flags ?? [])], defines: [...defines, `F_CPU=${board.clockHz}L`, 'ARDUINO=10819', 'ARDUINO_ARCH_RP2040', `ARDUINO_VARIANT="${recipe.variant}"`, `BOARD_NAME="${board.id}"`, 'USBD_VID=0x2e8a', 'USBD_PID=0x000a', 'USBD_MAX_POWER_MA=250', 'USB_MANUFACTURER="Wicro"', 'USB_PRODUCT="Wicro Arduino"', `PICO_FLASH_SIZE_BYTES=${board.metadata.flashCapacityBytes}`, 'FS_START=0', 'FS_END=0', '__PICO_RP2350A=1', 'LWIP_IPV6=0', 'LWIP_IPV4=1', ...(recipe.wifi ? ['CYW43_ARCH_THREADSAFE_BACKGROUND=1', 'ARDUINO_RASPBERRY_PI_PICO_W'] : []), ...(build.defines ?? [])], includeDirs, extraUnits, files: { 'compat/pico/config_autogen.h': config }, preopens: { '/sdk': root } };
  },
  async prepareLinkPlan({ host, board, compiledObjects }) {
    const root = host.sdkCacheDirectory, recipe = /** @type {PicoArduinoRecipe} */ (board.metadata.picoArduino);
    if (!root || !recipe?.chip) throw new Error('Pico Arduino SDK missing');
    const chip = String(recipe.chip), base = 'framework';
    let script = await text(host, root, `${base}/lib/${chip}/memmap_default.ld`);
    const flash = Number(board.metadata.flashCapacityBytes), ram = chip === 'rp2040' ? 256 * 1024 : 512 * 1024;
    if (chip.endsWith('riscv')) script = script.replace('    .rodata : {', '    .rodata : { *(.gcc_except_table .gcc_except_table.*)');
    const substitutions = { __FLASH_LENGTH__: flash - 8192, __RAM_LENGTH__: ram, __PSRAM_LENGTH__: 0, __EEPROM_START__: 0x10000000 + flash - 4096, __FS_START__: 0x10000000 + flash - 8192, __FS_END__: 0x10000000 + flash - 8192 };
    for (const [key, value] of Object.entries(substitutions)) script = script.replaceAll(key, String(value));
    const wraps = [];
    const inventory = /** @type {string[]} */ (JSON.parse(await text(host, root, 'inventory.json')));
    const wrapFiles = [`${base}/lib/core_wrap.txt`, `${base}/lib/${chip}/platform_wrap.txt`, ...inventory.filter((path) => path.startsWith('framework/cores/rp2040/lwip-wrappers/') && path.endsWith('_wraps.inc')), 'framework/libraries/LittleFS/src/wrap_lfs_wraps.inc'];
    for (const path of wrapFiles) for (const line of words(await text(host, root, path))) wraps.push(...line.split(',').filter((word) => word && word !== '-Wl'));
    const ota = await host.readFile(`${root}/${base}/lib/${chip}/ota.o`, { encoding: 'binary' });
    if (!(ota instanceof Uint8Array)) throw new Error('Genuine Pico OTA/startup object missing');
    const forced = ['runtime_init_install_ram_vector_table', '__pre_init_runtime_init_clocks', '__pre_init_runtime_init_bootrom_reset', '__pre_init_runtime_init_early_resets', '__pre_init_runtime_init_usb_power_down', '__pre_init_runtime_init_post_clock_resets', '__pre_init_runtime_init_spin_locks_reset', '__pre_init_runtime_init_boot_locks_reset', '__pre_init_runtime_init_bootrom_locking_enable', '__pre_init_runtime_init_mutex', '__pre_init_runtime_init_default_alarm_pool', '__pre_init_first_per_core_initializer', '__pre_init_runtime_init_per_core_bootrom_reset', '__pre_init_runtime_init_per_core_h3_irq_registers', '__pre_init_runtime_init_per_core_irq_priorities'];
    return { objects: { ...compiledObjects, 'ota.o': ota }, preopens: { '/sdk': root }, archivePaths: [`/sdk/framework/lib/${chip}/libpico.a`, `/sdk/framework/lib/${chip}/liblwip.a`, `/sdk/framework/lib/${chip}/libbearssl.a`, ...['libm.a', 'libc.a', 'libstdc++.a', 'libgcc.a'].map((name) => `/sdk/lib/${name}`)], linkerScripts: { 'pico.ld': script }, entry: '_entry_point', extraLinkerArgs: wraps, undefinedSymbols: forced, firmwareFormat: 'bin' };
  }
});
