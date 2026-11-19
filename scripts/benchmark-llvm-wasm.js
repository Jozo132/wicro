import { createHash } from 'node:crypto';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cpus, release } from 'node:os';
import { LlvmWasmToolchain, NodeWasiRunner } from '../packages/runtime/src/index.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const llvmPath = resolve(root, 'toolchain/llvm-wasm/cache/llvm.wasm');
const ldPath = resolve(root, 'toolchain/llvm-wasm/cache/ld.wasm');
const manifest = JSON.parse(await readFile(resolve(root, 'toolchain/llvm-wasm/manifest.json'), 'utf8'));

/** @param {number[]} values */
const summarize = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (/** @type {number} */ fraction) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0;
  return {
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted.at(-1) ?? 0,
    runs: values.length
  };
};

/** @param {()=>Promise<unknown>|unknown} operation */
const timed = async (operation) => {
  const start = performance.now();
  await operation();
  return performance.now() - start;
};

const llvm = await readFile(llvmPath);
const ld = await readFile(ldPath);
const sha256 = (/** @type {Uint8Array} */ bytes) => createHash('sha256').update(bytes).digest('hex');
const runner = new NodeWasiRunner();
const toolchain = new LlvmWasmToolchain({ llvmPath, linkerPath: ldPath, runner });

const cold = [];
const warm = [];
for (let index = 0; index < 5; index++) {
  const operation = async () => runner.run(llvmPath, { args: ['clang', '--print-targets'], preopens: {} });
  cold.push(await timed(operation));
}
for (let index = 0; index < 10; index++) {
  warm.push(await timed(async () => runner.run(llvmPath, { args: ['clang', '--print-targets'], preopens: {} })));
}

const compile = [];
const diagnostics = [];
for (let index = 0; index < 10; index++) {
  compile.push(await timed(() => toolchain.compileC('int main(void) { return 7; }\n', 'riscv32')));
  diagnostics.push(await timed(() => toolchain.diagnoseSource({ source: 'int main(void) { return missing_name; }\n', target: 'riscv32', language: 'c' })));
}

let browser = null;
try {
  browser = JSON.parse(await readFile(resolve(root, 'benchmarks/browser-wasm-benchmark.json'), 'utf8'));
} catch {
  // No browser measurement is present.
}

const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    osRelease: release(),
    architecture: process.arch,
    cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpuCount: cpus().length
  },
  llvm: {
    revision: manifest.revisions,
    rawBytes: llvm.length,
    gzipBytes: gzipSync(llvm).length,
    brotliBytes: brotliCompressSync(llvm).length,
    sha256: sha256(llvm)
  },
  linker: {
    rawBytes: ld.length,
    gzipBytes: gzipSync(ld).length,
    brotliBytes: brotliCompressSync(ld).length,
    sha256: sha256(ld)
  },
  browser,
  timings: {
    coldInitialization: summarize(cold),
    warmInitialization: summarize(warm),
    riscvCompile: summarize(compile),
    diagnostics: summarize(diagnostics)
  },
  skipped: {
    clangd: 'clangd.wasm is not present in the toolchain cache',
    clangTidy: 'clang-tidy.wasm is not present in the toolchain cache',
    clangFormat: 'clang-format.wasm is not present in the toolchain cache',
    llvmUtilities: 'Separate llvm-ar/objcopy/objdump/size/nm/readelf WASM binaries are not present'
  }
};

await mkdir(resolve(root, 'benchmarks'), { recursive: true });
await writeFile(resolve(root, 'benchmarks/llvm-wasm-benchmark.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
