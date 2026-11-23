# Wicro Canonical Platform Architecture

Wicro separates **host-independent build orchestration** (`@wicro/core`), **WASM toolchain execution** (`@wicro/runtime`), **immutable asset distribution & caching** (`@wicro/registry`), and **hardware transport/flashing** (`@wicro/programmers`) so the same engine runs identically in Node.js, browsers, and VS Code.

## Build Pipeline

```text
Resolve project (wicro.json)
  -> Resolve board, platform & framework (WicroPlatformRegistry)
  -> Resolve & verify SDK + WASM toolchain (SdkLifecycleManager / CompilerAssetManager)
  -> Discover & prepare sources (FrameworkAdapter.prepareSources)
  -> Compile units (LlvmWasmToolchain / BrowserLlvmWasmToolchain)
  -> Link ELF32 (PlatformAdapter.prepareLinkPlan -> ld.lld WASM)
  -> Generate & validate firmware artifacts (FirmwareFormatHandler: bin, hex, uf2, esp32-c3-bin)
  -> Flash, verify readback, reset & monitor (Programmer adapter)
```

The shared engine in `packages/core/src/index.js` contains **no board- or vendor-specific hardcoding**.

## Module Structure

- `packages/core/src/platform/registry.js` — `WicroPlatformRegistry` and canonical JSDoc interfaces (`ArchitectureDescriptor`, `PlatformAdapter`, `BoardDescriptor`, `FrameworkAdapter`, `FirmwareFormatHandler`, `ProgrammerDescriptor`).
- `packages/core/src/platform/architectures.js` — `BUILTIN_ARCHITECTURES` (`riscv32`, `riscv64`, `xtensa`, `armv6m`, `armv7-m`, `armv7e-m`, `armv8m-mainline`, `avr`) and `resolveArchitectureTargetArgs()`.
- `packages/core/src/platform/frameworks.js` — `arduinoFrameworkAdapter`, `bareMetalFrameworkAdapter`, `espIdfFrameworkAdapter`.
- `packages/core/src/platform/formats.js` — `elfFormatHandler`, `flatBinFormatHandler`, `intelHexFormatHandler`, `uf2FormatHandler`, `esp32C3BinFormatHandler`.
- `packages/core/src/platform/esp32.js` — `ESP32_C3_ARDUINO_RECIPE`, `prepareEsp32C3LinkerScripts()`, and `esp32C3PlatformAdapter`.
- `packages/core/src/platform/stm32.js` — `stm32BareMetalPlatformAdapter` (second-architecture validation for ARM Cortex-M3/M4/M7).
- `packages/core/src/platform/defaults.js` — `createDefaultPlatformRegistry()`.
- `packages/runtime/src/browser-toolchain.js` — `BrowserLlvmWasmToolchain` (`@bjorn3/browser_wasi_shim`, zero Node.js imports).
- `scripts/package-esp32-c3-sdk.js` — development-time asset packager emitting `dist/assets/esp32-c3-sdk-<version>.zip` and `dist/assets/distribution-manifest.json`.

## Extension Example

Prefer declarative board/SDK manifests in `registry/<name>/package.json` whenever possible. Programmatic extensions register through `WicroPlatformRegistry`:

```js
import { createWicroEngine, createDefaultPlatformRegistry } from '@wicro/core';

const platforms = createDefaultPlatformRegistry();

// 1. Register an architecture
platforms.registerArchitecture({
  id: 'my-riscv',
  name: 'Custom RV32IM',
  triple: 'riscv32-unknown-elf',
  elfMachine: 243,
  buildTargetArgs: (opts = {}) => [
    '--target=riscv32-unknown-elf',
    `-march=${opts.march ?? 'rv32im'}`,
    `-mabi=${opts.mabi ?? 'ilp32'}`
  ]
});

// 2. Register a framework
platforms.registerFramework({
  id: 'my-hal',
  name: 'Custom HAL',
  supportedExtensions: ['.c', '.cpp'],
  prepareSources: ({ sourcePaths, sourceFiles }) => ({
    units: sourcePaths.map((path) => ({ path, source: sourceFiles[path], language: path.endsWith('.cpp') ? 'c++' : 'c' }))
  }),
  defaultDefines: ({ board }) => [`F_CPU=${board.clockHz}L`, 'MY_HAL=1']
});

// 3. Register a firmware format
platforms.registerFirmwareFormat({
  id: 'my-bin',
  extension: '.mybin',
  description: 'Custom vendor image',
  convert: (elf) => new Uint8Array(elf),
  validate: (img) => ({ valid: img.length > 0, errors: img.length > 0 ? [] : ['Empty image'] })
});

// 4. Register a programmer descriptor
platforms.registerProgrammer({
  id: 'my-usb-prog',
  name: 'Custom USB Programmer',
  protocols: ['usb-dfu'],
  platforms: ['my-platform']
});

// 5. Register a platform family
platforms.registerPlatform({
  id: 'my-platform',
  family: 'my-family',
  architectures: ['my-riscv'],
  frameworks: ['my-hal'],
  defaultFirmwareFormat: 'my-bin',
  programmerId: 'my-usb-prog',
  matchesBoard: (board) => board.platform === 'my-platform',
  resolveCompileConfig: async ({ sdk }) => ({
    compilerFlags: ['-Os'],
    includeDirs: [...sdk.includeDirs],
    defines: ['MY_PLATFORM=1'],
    files: sdk.files
  }),
  prepareLinkPlan: async ({ host, board, project, compiledObjects }) => ({
    objects: compiledObjects,
    linkerScripts: { 'firmware.ld': String(await host.readFile(`${project}/${board.build.linkerScript}`, { encoding: 'utf8' })) },
    firmwareFormat: 'my-bin'
  })
});

// 6. Declare a board in registry/my-board/package.json with:
//    "metadata": { "platform": "my-platform", "architecture": "my-riscv", "framework": "my-hal",
//      "build": { "kind": "firmware", "target": "my-riscv", "linkerScript": "board.ld" } }
const engine = createWicroEngine({ host, platforms, llvmPath });
```

## Asset Distribution & Caching

- **Development-time asset generation** (`node scripts/package-esp32-c3-sdk.js`) packages the minimal ESP32-C3 SDK archive (`dist/assets/esp32-c3-sdk-4.20017.260907.zip`, `52,105,849` bytes, 4,631 files) and writes `dist/assets/distribution-manifest.json` with SHA-256 checksums. Neither directory is committed to Git or included in npm.
- **Production-time acquisition** (`SdkLifecycleManager` + `CompilerAssetManager`) verifies SHA-256 checksums via Web Crypto (`crypto.subtle`), extracts into an atomic staging directory before committing, deduplicates concurrent downloads, invalidates caches when manifest SHA-256 changes, and supports completely offline rebuilds (`wicro build --offline` or `WICRO_OFFLINE=1`).
