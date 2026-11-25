import { NANO_LINKER_SCRIPT } from '../packages/core/src/platform/nano.js';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { elfToAvrBin } from '../packages/runtime/src/avr-image.js';
import { LlvmWasmToolchain } from '../packages/runtime/src/index.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const framework = join(homedir(), '.platformio/packages/framework-arduino-avr');
const toolchain = join(homedir(), '.platformio/packages/toolchain-atmelavr');
const output = resolve('.wicro/nano');
await mkdir(output, { recursive: true });
const compiler = new LlvmWasmToolchain({ llvmPath: join(root, 'toolchain/llvm-wasm/cache/llvm.wasm') });
const preopens = { '/framework': framework, '/avr': join(toolchain, 'avr'), '/gcc': join(toolchain, 'lib/gcc/avr/7.3.0'), '/clang': join(root, 'toolchain/llvm-wasm/cache/clang-resource') };
const includes = ['/framework/cores/arduino', '/framework/variants/eightanaloginputs', '/avr/include', '/gcc/include'];
const defines = ['F_CPU=16000000L', 'ARDUINO=10819', 'ARDUINO_AVR_NANO', 'ARDUINO_ARCH_AVR'];
/** @type {Record<string,Uint8Array>} */
const objects = {};
/** @param {string} name @param {string} source @param {'c'|'c++'} language */
const compile = async (name, source, language) => {
  console.log(`WASM compile ${name}`);
  const result = await compiler.compileSource(source, 'avr', { mcu: 'atmega328p' }, { language, preopens, includeDirs: [...includes, `/framework/cores/arduino/${dirname(name)}`], defines,
    compilerFlags: ['-resource-dir=/clang', '-Os', '-ffunction-sections', '-fdata-sections', '-fno-builtin', '-Wno-unknown-attributes', ...(language === 'c++' ? ['-std=gnu++11', '-fno-exceptions', '-fno-rtti', '-fno-threadsafe-statics'] : ['-std=gnu11'])], cacheDirectory: join(output, 'objects') });
  objects[name + '.o'] = result.object;
};
for (const name of (await readdir(join(framework, 'cores/arduino'))).sort()) if (/\.(c|cpp)$/.test(name) && !['CDC.cpp', 'USBCore.cpp', 'PluggableUSB.cpp'].includes(name)) await compile(name, await readFile(join(framework, 'cores/arduino', name), 'utf8'), name.endsWith('.cpp') ? 'c++' : 'c');
await compile('sketch.cpp', '#include <Arduino.h>\nvoid setup(){ pinMode(LED_BUILTIN,OUTPUT); Serial.begin(115200); Serial.println("WICRO_NANO_READY"); }\nvoid loop(){ digitalWrite(LED_BUILTIN,LOW);Serial.println("WICRO_NANO_TICK LOW");delay(500);digitalWrite(LED_BUILTIN,HIGH);Serial.println("WICRO_NANO_TICK HIGH");delay(500);}\n', 'c++');
const linker = NANO_LINKER_SCRIPT;
const crt = new Uint8Array(await readFile(join(toolchain, 'avr/lib/avr5/crtatmega328p.o')));
const linked = await compiler.linkElf({ preObjects: { 'crt.o': crt }, objects, preopens, archivePaths: ['/avr/lib/avr5/libatmega328p.a', '/avr/lib/avr5/libc.a', '/avr/lib/avr5/libm.a', '/gcc/avr5/libgcc.a'], linkerScripts: { 'nano.ld': linker }, target: 'avr', entry: '__vectors', emitBinary: false });
await writeFile(join(output, 'firmware.elf'), linked.elf);
await writeFile(join(output, 'firmware.bin'), elfToAvrBin(linked.elf));
console.log(`WASM Arduino Nano ELF linked: ${linked.elf.length} bytes`);
