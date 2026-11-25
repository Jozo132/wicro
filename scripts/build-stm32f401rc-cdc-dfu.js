import { homedir } from 'node:os';
import { resolve, join, relative, dirname } from 'node:path';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { LlvmWasmToolchain } from '../packages/runtime/src/index.js';
import { extractLibraryArchive } from '../packages/registry/src/library-archive.js';
import { downloadBytes } from '../packages/registry/src/download.js';
import { sha256Bytes } from '../packages/registry/src/sdk.js';

// Development fixture builder: genuine cached STM32duino/CMSIS/newlib sources;
// compiler and linker are the same WASM tools used by the shared Wicro engine.
const root = resolve(new URL('..', import.meta.url).pathname);
/** @param {string} name @param {string} fallback */
const option = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const framework = resolve(option('framework', join(homedir(), '.platformio/packages/framework-arduinoststm32')));
const cmsis = resolve(option('cmsis', join(homedir(), '.platformio/packages/framework-cmsis/CMSIS')));
const toolchainRoot = resolve(option('sysroot', join(homedir(), '.platformio/packages/toolchain-gccarmnoneeabi')));
const sysroot = join(toolchainRoot, 'arm-none-eabi');
const variant = join(framework, 'variants/STM32F4xx/F401R(B-C-D-E)T');
const output = resolve(option('output', join(root, '.wicro/stm32f401rc-cdc-dfu')));
await mkdir(output, { recursive: true });
const version = (await readdir(join(sysroot, 'include/c++'))).sort().at(-1);
if (version !== '12.3.1') throw new Error('This development fixture requires the tested ARM newlib/libstdc++ 12.3.1 sysroot');
const frameworkManifest = JSON.parse(await readFile(join(framework, 'package.json'), 'utf8'));
if (frameworkManifest.version !== '4.30000.0') throw new Error('This development fixture requires STM32duino 3.0.0 (PlatformIO framework 4.30000.0)');
const archiveSha = '64911fd4004b4fc8e311fb55cfc06e0d7f5fd2f8fc215c1d22480d92e13e3afe';
const archivePath = join(output, 'cdc-dfu-1.1.2.tar.gz');
let archive;
try { archive = new Uint8Array(await readFile(archivePath)); } catch { archive = await downloadBytes('https://dl.registry.platformio.org/download/jozo132/library/cdc-dfu/1.1.2/cdc-dfu-1.1.2.tar.gz'); await writeFile(archivePath, archive); }
if (await sha256Bytes(archive) !== archiveSha) throw new Error('Pinned CDC-DFU archive checksum mismatch');
const packageFiles = extractLibraryArchive(archive, 'tar.gz');
await mkdir(join(output, 'bridge'), { recursive: true });
for (const [name, bytes] of Object.entries(packageFiles)) if (name.startsWith('src/')) await writeFile(join(output, 'bridge', name.slice(4)), bytes);
const preopens = { '/bridge': join(output, 'bridge'), '/clang-resource': join(root, 'toolchain/llvm-wasm/cache/clang-resource'), '/framework': framework, '/cmsis': cmsis, '/sysroot': sysroot, '/gcc': join(toolchainRoot, 'lib/gcc/arm-none-eabi', version), '/variant': variant };
const includes = [
  '/framework/cores/arduino', '/framework/cores/arduino/avr', '/framework/cores/arduino/stm32', '/framework/cores/arduino/api/deprecated',
  '/framework/libraries/SrcWrapper/inc', '/framework/libraries/SrcWrapper/inc/LL', '/framework/libraries/USBDevice/inc', '/framework/libraries/VirtIO/inc',
  '/framework/system/Drivers/STM32F4xx_HAL_Driver/Inc', '/framework/system/Drivers/STM32F4xx_HAL_Driver/Src', '/framework/system/STM32F4xx',
  '/framework/system/Middlewares/ST/STM32_USB_Device_Library/Core/Inc', '/framework/system/Middlewares/ST/STM32_USB_Device_Library/Core/Src',
  '/framework/system/Drivers/CMSIS/Device/ST/STM32F4xx/Include', '/cmsis/Core/Include', '/cmsis/DSP/Include', '/variant',
  `/sysroot/include/c++/${version}`, `/sysroot/include/c++/${version}/arm-none-eabi/thumb/v7e-m+fp/hard`, `/sysroot/include/c++/${version}/arm-none-eabi`, `/sysroot/include/c++/${version}/backward`, '/sysroot/include'
];
const defines = ['STM32F4xx', 'STM32F401xC', 'ARDUINO=10808', 'ARDUINO_ARCH_STM32', 'ARDUINO_GENERIC_F401RCTX', 'VARIANT_H="variant_generic.h"', 'BOARD_NAME="Wicro F401RC CDC-DFU"', 'F_CPU=84000000L', 'USE_HAL_DRIVER', 'USE_FULL_LL_DRIVER', 'HAL_UART_MODULE_ENABLED', 'EXTENDED_PIN_MODE', 'NDEBUG', 'USBCON', 'USBD_USE_CDC', 'PIO_FRAMEWORK_ARDUINO_ENABLE_CDC', 'HAL_PCD_MODULE_ENABLED', 'USB_VID=0x0483', 'USB_PID=0x5740', 'DTR_TOGGLING_SEQ', 'GCC_VERSION=120301'];
const flags = ['-resource-dir=/clang-resource', '-Os', '-ffunction-sections', '-fdata-sections', '-mfpu=fpv4-sp-d16', '-mfloat-abi=hard', '-Wno-unknown-attributes', '-Wno-ignored-attributes'];
/** @param {string} directory @returns {Promise<string[]>} */
const sources = async (directory) => {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sources(path));
    else if (/\.(c|cpp)$/.test(path)) result.push(path);
  }
  return result.sort();
};
const sourceFiles = [...await sources(join(framework, 'cores/arduino')), ...await sources(join(framework, 'libraries/SrcWrapper')), ...await sources(join(framework, 'libraries/USBDevice')), ...await sources(variant)];
const compiler = new LlvmWasmToolchain({ llvmPath: join(root, 'toolchain/llvm-wasm/cache/llvm.wasm') });
/** @type {Record<string,Uint8Array>} */
const objects = {};
/** @param {string} name @param {string} source @param {'c'|'c++'|'assembly'} language */
const compile = async (name, source, language) => {
  console.log(`WASM compile ${name}`);
  const result = await compiler.compileSource(source, 'armv7e-m', { mcpu: 'cortex-m4' }, { language, includeDirs: [...includes, '/bridge', `/framework/${dirname(name)}`], defines, preopens, compilerFlags: [...flags, ...(language === 'c++' ? ['-std=gnu++17', '-fno-threadsafe-statics', '-fno-rtti', '-fno-exceptions', '-fno-use-cxa-atexit'] : language === 'c' ? ['-std=gnu17'] : [])], cacheDirectory: join(output, 'objects') });
  objects[`${Object.keys(objects).length}.o`] = result.object;
};
for (const path of sourceFiles) await compile(relative(framework, path), await readFile(path, 'utf8'), path.endsWith('.cpp') ? 'c++' : 'c');
await compile('startup_stm32f401xc.s', await readFile(join(framework, 'system/Drivers/CMSIS/Device/ST/STM32F4xx/Source/Templates/gcc/startup_stm32f401xc.s'), 'utf8'), 'assembly');
await compile('cdc_dfu.cpp', new TextDecoder().decode(packageFiles['src/cdc_dfu.cpp']), 'c++');
await compile('sketch.cpp', '#include <Arduino.h>\nvoid setup() { Serial.begin(115200); pinMode(PC13, OUTPUT); }\nvoid loop() { digitalWrite(PC13, LOW); Serial.println("WICRO_F401RC_CDC_DFU_READY"); delay(500); digitalWrite(PC13, HIGH); delay(500); }\n', 'c++');
let linker = await readFile(join(variant, 'ldscript.ld'), 'utf8');
linker = linker.replace(/\(READONLY\)/g, '').replace(/\bLD_MAX_DATA_SIZE\b/g, '65536').replace(/\bLD_MAX_SIZE\b/g, '262144').replace(/\bLD_FLASH_OFFSET\b/g, '0');
linker = linker.replace('_estack = ORIGIN(RAM) + LENGTH(RAM);', '_estack = 0x20010000;');
linker = linker.replace(/  \.\_user_heap_stack/, '  .noinit (NOLOAD) : { . = ALIGN(32); *(.noinit .noinit*) . = ALIGN(4); } >RAM\n  ._user_heap_stack');
objects['crti.o'] = new Uint8Array(await readFile(join(toolchainRoot, 'lib/gcc/arm-none-eabi', version, 'thumb/v7e-m+fp/hard/crti.o')));
objects['crtn.o'] = new Uint8Array(await readFile(join(toolchainRoot, 'lib/gcc/arm-none-eabi', version, 'thumb/v7e-m+fp/hard/crtn.o')));
const linked = await compiler.linkElf({ objects, linkerScripts: { 'stm32f401rc.ld': linker }, archivePaths: ['/sysroot/lib/thumb/v7e-m+fp/hard/libc_nano.a', '/sysroot/lib/thumb/v7e-m+fp/hard/libm.a', '/sysroot/lib/thumb/v7e-m+fp/hard/libstdc++_nano.a', '/gcc/thumb/v7e-m+fp/hard/libgcc.a'], preopens, target: 'armv7e-m', entry: 'Reset_Handler' });
await writeFile(join(output, 'firmware.elf'), linked.elf);
await writeFile(join(output, 'firmware.bin'), linked.bin);
await writeFile(join(output, 'build.json'), JSON.stringify({ compiler: 'LLVM/LLD WASM', board: 'STM32F401RC', framework: JSON.parse(await readFile(join(framework, 'package.json'), 'utf8')), cdcDfuVersion: '1.1.2', archiveSha, defines, units: Object.keys(objects).length, bytes: linked.bin.length, sha256: await sha256Bytes(linked.bin) }, null, 2));
console.log(`WASM firmware linked: ${linked.bin.length} bytes at ${output}`);
