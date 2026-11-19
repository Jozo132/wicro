# LLVM WASM Benchmark

Generated: 2026-11-19T22:54:53.800Z

## Environment

- Node.js: v22.22.3
- OS: Linux 6.14.0-37-generic
- Architecture: x64
- CPU: AMD Ryzen 9 7900X 12-Core Processor
- Logical CPUs: 24

## Revisions

- esp-wasm: `dceb9e3126898359bff8ab9e44bec5b65d87b5d3`
- LLVM project: `esp-20.1.1_20250829`
- LLVM project commit: `50f388758bdf0b0d99018a6f2b1d3402bdb51002`
- WASI SDK: `34.0`

## Binary Sizes

| Artifact | Raw | Gzip | Brotli |
|---|---:|---:|---:|
| LLVM WASM | 59,663,950 bytes | 19,565,712 bytes | 13,593,233 bytes |
| LD WASM | 1,657,054 bytes | 488,377 bytes | 399,468 bytes |

LLVM SHA-256: `32a1fb128050002a4e2c8797c4730fbd08bdb6c6991c204645d92aec85b212d4`

LD SHA-256: `cb8d0a223ca28c5eefc134399d7a54313b95ab5c7f1cbf84edccb23080f58c32`

## Node WASI Timings

| Operation | Runs | Median | P95 | Maximum |
|---|---:|---:|---:|---:|
| Cold initialization | 5 | 163.172 ms | 166.404 ms | 166.404 ms |
| Warm initialization | 10 | 159.898 ms | 165.823 ms | 165.823 ms |
| RISC-V object compilation | 10 | 628.730 ms | 657.824 ms | 657.824 ms |
| Syntax diagnostics | 10 | 192.539 ms | 196.768 ms | 196.768 ms |

These Node results measure the existing LLVM/LD WASM binaries. They are not combined-distribution figures.

## Browser WASM Compile

- Runtime: Chromium local IDE
- Page: `http://127.0.0.1:5173/`
- Raw LLVM WASM fetch: 44.400 ms (59,663,950 bytes)
- Runs: 5
- Median compile: 56.200 ms
- P95 compile: 58.700 ms
- Maximum compile: 58.700 ms

## Skipped Measurements

- Clangd: `clangd.wasm` is absent.
- Clang-Tidy: `clang-tidy.wasm` is absent.
- Clang-Format: `clang-format.wasm` is absent.
- LLVM utilities: separate utility WASM binaries are absent.
