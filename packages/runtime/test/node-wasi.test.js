import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LlvmWasmToolchain, NodeWasiRunner } from '../src/index.js';

const llvmUrl = new URL('../../../toolchain/llvm-wasm/cache/llvm.wasm', import.meta.url);
const ldUrl = new URL('../../../toolchain/llvm-wasm/cache/ld.wasm', import.meta.url);
const manifestUrl = new URL('../../../toolchain/llvm-wasm/manifest.json', import.meta.url);

test('shared compiler manifest lists targets and matches LLVM cache integrity', async () => {
  const [manifest, wasm] = await Promise.all([
    readFile(manifestUrl, 'utf8').then((text) => JSON.parse(text)),
    readFile(llvmUrl)
  ]);
  const hash = createHash('sha256').update(wasm).digest('hex');

  assert.deepEqual(manifest.targets, ['armv6m', 'armv7-m', 'armv7e-m', 'armv8m-mainline', 'avr', 'riscv32', 'riscv64', 'xtensa']);
  assert.equal(manifest.integrity['llvm.wasm'], hash);
});

test('Node WASI runner executes LLVM and reports RISC-V targets', async () => {
  const runner = new NodeWasiRunner();
  const result = await runner.run(llvmUrl.pathname, {
    args: ['clang', '--print-targets'],
    preopens: {}
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /riscv32/);
});

test('shared LLVM toolchain exposes RISC-V and Xtensa target arguments', () => {
  const toolchain = new LlvmWasmToolchain({ llvmPath: llvmUrl.pathname });

  assert.deepEqual(toolchain.targetArgs('riscv32'), [
    '--target=riscv32-esp-elf',
    '-march=rv32imc',
    '-mabi=ilp32'
  ]);
  assert.deepEqual(toolchain.targetArgs('xtensa', { mcpu: 'esp32s3' }), [
    '--target=xtensa-esp-elf',
    '-mcpu=esp32s3'
  ]);
});

test('shared LLVM toolchain exposes ARM and AVR target arguments', () => {
  const toolchain = new LlvmWasmToolchain({ llvmPath: llvmUrl.pathname });

  assert.deepEqual(toolchain.targetArgs('armv7-m'), [
    '--target=arm-none-eabi',
    '-mcpu=cortex-m3',
    '-mthumb',
    '-mfloat-abi=soft'
  ]);
  assert.deepEqual(toolchain.targetArgs('armv7e-m'), [
    '--target=arm-none-eabi',
    '-mcpu=cortex-m4',
    '-mthumb',
    '-mfloat-abi=hard'
  ]);
  assert.deepEqual(toolchain.targetArgs('avr', { mcu: 'atmega328p' }), [
    '--target=avr',
    '-mmcu=atmega328p'
  ]);
});

test('shared LLVM toolchain returns real syntax diagnostics', async () => {
  const toolchain = new LlvmWasmToolchain({ llvmPath: llvmUrl.pathname });
  const result = await toolchain.diagnoseSource({
    source: 'int main(void) { return missing_name; }\n',
    target: 'riscv32',
    language: 'c'
  });

  assert.equal(result.exitCode !== 0, true);
  assert.ok(result.diagnostics.some((diagnostic) => /missing_name|undeclared|unknown/.test(diagnostic.message)));
});

test('shared LLVM toolchain reports completion entry execution', async () => {
  const toolchain = new LlvmWasmToolchain({ llvmPath: llvmUrl.pathname });
  const result = await toolchain.completeSource({
    source: 'int main(void) { re\n}',
    target: 'riscv32',
    language: 'c',
    line: 1,
    column: 4
  });

  assert.equal(typeof result.exitCode, 'number');
  assert.equal(Array.isArray(result.candidates), true);
});

test('shared LLVM toolchain compiles a RISC-V object', async () => {
  const toolchain = new LlvmWasmToolchain({ llvmPath: llvmUrl.pathname });
  const result = await toolchain.compileC('int main(void) { return 7; }\n', 'riscv32');

  assert.equal(result.target, 'riscv32');
  assert.equal(result.object.readUInt32LE(0), 0x464c457f);
  assert.equal(result.object.length > 100, true);
});

test('shared LLVM toolchain compiles a Cortex-M3 object', async () => {
  const toolchain = new LlvmWasmToolchain({ llvmPath: llvmUrl.pathname });
  const result = await toolchain.compileC('int main(void) { return 7; }\n', 'armv7-m', { mcpu: 'cortex-m3' });

  assert.equal(result.target, 'armv7-m');
  assert.equal(result.object.readUInt32LE(0), 0x464c457f);
  assert.equal(result.object.length > 100, true);
});

test('shared LLVM toolchain compiles an ARMv7E-M object', async () => {
  const toolchain = new LlvmWasmToolchain({ llvmPath: llvmUrl.pathname });
  const result = await toolchain.compileC('int main(void) { return 7; }\n', 'armv7e-m', { mcpu: 'cortex-m4' });

  assert.equal(result.target, 'armv7e-m');
  assert.equal(result.object.readUInt32LE(0), 0x464c457f);
  assert.equal(result.object.length > 100, true);
});

test('shared LLVM toolchain compiles a Cortex-M7 object', async () => {
  const toolchain = new LlvmWasmToolchain({ llvmPath: llvmUrl.pathname });
  const result = await toolchain.compileC('int main(void) { return 7; }\n', 'armv7e-m', { mcpu: 'cortex-m7' });

  assert.equal(result.target, 'armv7e-m');
  assert.equal(result.object.readUInt32LE(0), 0x464c457f);
  assert.equal(result.object.length > 100, true);
});

test('shared LLVM toolchain compiles an RP2040 object', async () => {
  const toolchain = new LlvmWasmToolchain({ llvmPath: llvmUrl.pathname });
  const result = await toolchain.compileC('int main(void) { return 7; }\n', 'armv6m', { mcpu: 'cortex-m0plus' });

  assert.equal(result.target, 'armv6m');
  assert.equal(result.object.readUInt32LE(0), 0x464c457f);
  assert.equal(result.object.length > 100, true);
});

test('shared LLVM toolchain compiles an RP2350 object', async () => {
  const toolchain = new LlvmWasmToolchain({ llvmPath: llvmUrl.pathname });
  const result = await toolchain.compileC('int main(void) { return 7; }\n', 'armv8m-mainline', { mcpu: 'cortex-m33' });

  assert.equal(result.target, 'armv8m-mainline');
  assert.equal(result.object.readUInt32LE(0), 0x464c457f);
  assert.equal(result.object.length > 100, true);
});

test('shared LLVM toolchain compiles C++ and assembly sources', async () => {
  const toolchain = new LlvmWasmToolchain({ llvmPath: llvmUrl.pathname });
  const cpp = await toolchain.compileSource('int value() { return 7; }\n', 'riscv32', undefined, { language: 'c++' });
  const assembly = await toolchain.compileSource('.global value\nvalue:\n  nop\n', 'riscv32', undefined, { language: 'assembly' });

  assert.equal(cpp.object.subarray(0, 4).toString('hex'), '7f454c46');
  assert.equal(assembly.object.subarray(0, 4).toString('hex'), '7f454c46');
});

test('shared LLVM object cache reports persistent hits', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'wicro-object-cache-'));
  const toolchain = new LlvmWasmToolchain({ llvmPath: llvmUrl.pathname });

  try {
    const first = await toolchain.compileSource('int main(void) { return 7; }\n', 'riscv32', undefined, { cacheDirectory: cache });
    const second = await toolchain.compileSource('int main(void) { return 7; }\n', 'riscv32', undefined, { cacheDirectory: cache });
    assert.equal(first.cache, 'miss');
    assert.equal(second.cache, 'hit');
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});

test('shared LLVM toolchain compiles an AVR object', async () => {
  const toolchain = new LlvmWasmToolchain({ llvmPath: llvmUrl.pathname });
  const result = await toolchain.compileC('int main(void) { return 7; }\n', 'avr', { mcu: 'atmega328p' });

  assert.equal(result.target, 'avr');
  assert.equal(result.object.readUInt32LE(0), 0x464c457f);
  assert.equal(result.object.length > 100, true);
});

test('shared LLVM toolchain links generated Arduino C++ for a bare-metal target', async () => {
  const { readFile } = await import('node:fs/promises');
  const toolchain = new LlvmWasmToolchain({ llvmPath: llvmUrl.pathname });
  const startupSource = await readFile(new URL('../../../examples/stm32f103cb/bare-metal-blink/startup.c', import.meta.url), 'utf8');
  const linkerScript = await readFile(new URL('../../../examples/stm32f103cb/bare-metal-blink/stm32f103cb.ld', import.meta.url), 'utf8');

  const result = await toolchain.compileAndLinkBareMetal({
    source: 'void setup() {}\nvoid loop() {}\nextern "C" int main(void) { setup(); for (;;) { loop(); } return 0; }\n',
    startupSource,
    linkerScript,
    target: 'armv7-m',
    targetOptions: { mcpu: 'cortex-m3' },
    language: 'c++'
  });

  assert.equal(result.elf.subarray(0, 4).toString('hex'), '7f454c46');
  assert.equal(result.bin.length > 0, true);
});

test('shared LLVM toolchain links STM32F103CB ELF and BIN', async () => {
  const { readFile } = await import('node:fs/promises');
  const toolchain = new LlvmWasmToolchain({ llvmPath: llvmUrl.pathname });
  const source = await readFile(new URL('../../../examples/stm32f103cb/bare-metal-blink/main.c', import.meta.url), 'utf8');
  const startupSource = await readFile(new URL('../../../examples/stm32f103cb/bare-metal-blink/startup.c', import.meta.url), 'utf8');
  const linkerScript = await readFile(new URL('../../../examples/stm32f103cb/bare-metal-blink/stm32f103cb.ld', import.meta.url), 'utf8');

  const result = await toolchain.compileAndLinkBareMetal({
    source,
    startupSource,
    linkerScript,
    target: 'armv7-m',
    targetOptions: { mcpu: 'cortex-m3' }
  });

  assert.equal(result.elf.subarray(0, 4).toString('hex'), '7f454c46');
  assert.equal(result.elf.readUInt16LE(18), 40);
  assert.equal(result.bin.length > 0, true);
});

test('shared LLVM toolchain links STM32H723VG ELF and BIN', async () => {
  const { readFile } = await import('node:fs/promises');
  const toolchain = new LlvmWasmToolchain({ llvmPath: llvmUrl.pathname });
  const source = await readFile(new URL('../../../examples/stm32h723vg/bare-metal-blink/main.c', import.meta.url), 'utf8');
  const startupSource = await readFile(new URL('../../../examples/stm32h723vg/bare-metal-blink/startup.c', import.meta.url), 'utf8');
  const linkerScript = await readFile(new URL('../../../examples/stm32h723vg/bare-metal-blink/stm32h723vg.ld', import.meta.url), 'utf8');

  const result = await toolchain.compileAndLinkBareMetal({
    source,
    startupSource,
    linkerScript,
    target: 'armv7e-m',
    targetOptions: { mcpu: 'cortex-m7' }
  });

  assert.equal(result.elf.subarray(0, 4).toString('hex'), '7f454c46');
  assert.equal(result.elf.readUInt16LE(18), 40);
  assert.equal(result.bin.length > 0, true);
});

test('WASM ESP32 linker emits a real ELF for staged object/script inputs', async () => {
  const toolchain = new LlvmWasmToolchain({ llvmPath: llvmUrl.pathname });
  const compiled = await toolchain.compileC('int firmware_entry(void) { return 7; }\n', 'riscv32', { march: 'rv32imc', mabi: 'ilp32' });
  const result = await toolchain.linkEsp32Elf({
    objects: { 'main.o': compiled.object },
    linkerScripts: { 'firmware.ld': 'MEMORY { IRAM (rx) : ORIGIN = 0x40370000, LENGTH = 0x10000 }\nSECTIONS { .text : { *(.text*) } > IRAM }' },
    target: 'riscv32',
    targetOptions: { march: 'rv32imc', mabi: 'ilp32' },
    entry: 'firmware_entry'
  });
  assert.equal(result.elf.subarray(0, 4).toString('hex'), '7f454c46');
  assert.equal(result.elf.readUInt16LE(18), 243);
});

test('shared LLVM linker is executable', async () => {
  const runner = new NodeWasiRunner();
  const result = await runner.run(ldUrl.pathname, {
    args: ['ld', '--version'],
    preopens: {}
  });

  assert.equal(result.exitCode, 0);
});

test('shared LLVM toolchain compiles a Xtensa object', async () => {
  const toolchain = new LlvmWasmToolchain({ llvmPath: llvmUrl.pathname });
  const result = await toolchain.compileC('int main(void) { return 7; }\n', 'xtensa', { mcpu: 'esp32' });

  assert.equal(result.target, 'xtensa');
  assert.equal(result.object.readUInt32LE(0), 0x464c457f);
  assert.equal(result.object.length > 100, true);
});

test('shared LLVM toolchain reports all available targets', async () => {
  const toolchain = new LlvmWasmToolchain({ llvmPath: llvmUrl.pathname });
  const targets = await toolchain.targets();

  assert.ok(targets.includes('armv7-m'));
  assert.ok(targets.includes('armv7e-m'));
  assert.ok(targets.includes('avr'));
  assert.ok(targets.includes('riscv32'));
  assert.ok(targets.includes('riscv64'));
  assert.ok(targets.includes('xtensa'));
});

test('Node WASI runner can compile a RISC-V relocatable ELF', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wicro-wasi-'));

  try {
    await writeFile(join(directory, 'main.c'), 'int main(void) { return 7; }\n');
    const runner = new NodeWasiRunner();
    const result = await runner.run(llvmUrl.pathname, {
      args: ['clang', '--target=riscv32-esp-elf', '-march=rv32imc', '-mabi=ilp32', '-nostdlib', '-c', '/tmp/main.c', '-o', '/tmp/main.o'],
      preopens: { '/tmp': directory }
    });

    assert.equal(result.exitCode, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
