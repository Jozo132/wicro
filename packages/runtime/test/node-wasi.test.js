import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NodeWasiRunner } from '../src/index.js';

const llvmUrl = new URL('../../../toolchain/esp32-c3/cache/llvm.wasm', import.meta.url);

test('Node WASI runner executes LLVM and reports RISC-V targets', async () => {
  const runner = new NodeWasiRunner();
  const result = await runner.run(llvmUrl.pathname, {
    args: ['clang', '--print-targets'],
    preopens: {}
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /riscv32/);
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
