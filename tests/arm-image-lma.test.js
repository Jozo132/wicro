import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { LlvmWasmToolchain } from '../packages/runtime/src/index.js';
import { flatBinFormatHandler, intelHexFormatHandler } from '../packages/core/src/platform/formats.js';

test('shared ARM BIN/HEX place initialized SRAM data at its ELF physical flash load address', async () => {
  const toolchain = new LlvmWasmToolchain({ llvmPath: resolve('toolchain/llvm-wasm/cache/llvm.wasm') });
  const linked = await toolchain.compileAndLinkBareMetal({
    source: 'volatile unsigned initialized = 0x12345678; volatile unsigned zeroed; int main(void){zeroed=initialized;for(;;){}}',
    startupSource: 'extern int main(void);void Reset_Handler(void){main();} __attribute__((section(".vectors"),used)) const unsigned vectors[2]={0x20005000,(unsigned)Reset_Handler};',
    linkerScript: 'ENTRY(Reset_Handler)\nMEMORY { FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 64K\n RAM (rwx) : ORIGIN = 0x20000000, LENGTH = 20K }\nSECTIONS { .vectors : { KEEP(*(.vectors)) } >FLASH\n .text : { *(.text*) *(.rodata*) } >FLASH\n .ARM.exidx : { *(.ARM.exidx*) } >FLASH\n .data : { *(.data*) } >RAM AT>FLASH\n .bss (NOLOAD) : { *(.bss*) } >RAM }',
    target: 'armv7-m', targetOptions: { mcpu: 'cortex-m3' }
  });
  const image = await flatBinFormatHandler.convert(linked.elf, { flashCapacityBytes: 65536 });
  assert.ok(image.length < 1024);
  assert.deepEqual(image, linked.bin);
  const view = new DataView(linked.elf.buffer, linked.elf.byteOffset, linked.elf.byteLength), start = view.getUint32(28, true), stride = view.getUint16(42, true);
  let dataAddress = 0;
  for (let index = 0; index < view.getUint16(44, true); index++) { const at = start + index * stride; if (view.getUint32(at, true) === 1 && view.getUint32(at + 8, true) === 0x20000000) dataAddress = view.getUint32(at + 12, true); }
  assert.ok(dataAddress >= 0x08000000 && dataAddress < 0x08010000);
  assert.equal(new DataView(image.buffer, image.byteOffset, image.byteLength).getUint32(dataAddress - 0x08000000, true), 0x12345678);
  const hex = new TextDecoder().decode(await intelHexFormatHandler.convert(linked.elf));
  assert.ok(hex.includes('78563412'));
  await assert.rejects(async () => flatBinFormatHandler.convert(linked.elf, { flashCapacityBytes: 8 }), /flash bounds/);
});
