# Common LLVM WASM toolchain

The common compiler package covers ARM, AVR, RISC-V 32/64 and Xtensa target backends.

```sh
JOBS=24 LLVM_TARGETS='ARM;AVR;RISCV' ./build-common.sh cache
```

The build produces:

- `cache/llvm.wasm`
- `cache/ld.wasm` when the linker stage is available
- `cache/manifest.json`

Downloaded compiler assets are ignored by Git. Board-specific ESP-IDF sysroots and linker scripts remain independent packages.
