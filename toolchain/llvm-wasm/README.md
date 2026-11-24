# Common LLVM WASM toolchain

The common compiler package covers ARM, AVR, RISC-V 32/64 and Xtensa target backends.

```sh
npm run build:llvm
```

The Node orchestrator verifies prerequisites without installing privileged software. It uses:

- **Windows:** MSVC from a Visual Studio developer environment, Windows SDK headers and libraries, CMake, Ninja, Git, curl, and tar.
- **Linux:** native `clang`/`cc`, `clang++`/`c++`, CMake, Ninja, Git, curl, and tar.
- **macOS:** native Clang, CMake, Ninja, Git, curl, and tar.

WSL and Docker are never used. The Node orchestrator configures MSVC-hosted LLVM TableGen utilities on Windows, then cross-compiles pinned Espressif LLVM source to `wasm32-wasip1` with the platform-matched WASI SDK. Linux and macOS use native host C/C++ tools and the matching WASI SDK archive.

A SHA-256-verified `cache/llvm.wasm` entry is reused before host prerequisite checks. If the cache is missing or mismatched, the pinned GitHub release assets are downloaded and independently SHA-256-verified before source compilation is considered. `--cache-only` reports an error unless the cache matches the manifest and never uses the release fallback. `--offline` also disables network fallback and requires local cache or source prerequisites. `--force` deliberately ignores a verified cache and starts the native source-build path.

You can override build settings in the environment:

```sh
JOBS=24 LLVM_TARGETS='ARM;AVR;RISCV' npm run build:llvm
```

PowerShell accepts the same overrides before running npm:

```powershell
$env:JOBS = '24'
$env:LLVM_TARGETS = 'ARM;AVR;RISCV'
npm run build:llvm
```

The release fallback points to `llvm-wasm-v1.0.0` assets in the Wicro GitHub repository and must match the `sha256`/`uncompressedSha256` fields in `manifest.json`. Downloaded prebuilt assets are written only after verification.

Prerequisite-only diagnostics are available without rebuilding:

```sh
node scripts/build-llvm-wasm.js --dry-run
node scripts/build-llvm-wasm.js --cache-only
```

For a native Windows rebuild, the script uses `vswhere.exe` to locate Visual Studio Build Tools and `VsDevCmd.bat`, then initializes an x64 MSVC environment for child processes. It validates `cl.exe`, `link.exe`, `rc.exe`, Windows SDK `INCLUDE`/`LIB`, CMake, Ninja, Git, curl, tar, and the WASI SDK individually. Install missing components through Visual Studio Installer or normal package management; the script never attempts privileged installation. Ordinary PowerShell can run `--dry-run` without MSVC, but an actual rebuild requires the complete native toolchain.

The build produces:

- `cache/llvm.wasm`
- `cache/ld.wasm` when the linker stage is available
- `cache/manifest.json`

Downloaded compiler assets are ignored by Git. Board-specific ESP-IDF sysroots and linker scripts remain independent packages.
