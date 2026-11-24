# Wicro

Wicro is a universal embedded development platform for browsers, VS Code, and Node.js. It uses a shared ESM core, host-specific adapters and WebAssembly tooling.

The npm package is `@jozo132/wicro`. Its command-line executable is `wicro`.

## Verified now

- Node.js CLI and npm/npx installation
- Strict JSDoc source checking
- Package manifest, semver, archive and virtual filesystem foundations
- Parallel build task DAG with cycle detection
- Shared LLVM/LLD WASM compiler covering ARM, AVR, RISC-V 32/64 and Xtensa targets, with WASM ELF/BIN linking for STM32 bare-metal examples
- Manifest-driven build recipes shared by CLI, browser and VS Code surfaces
- Registry installation, removal, updates, transitive resolution and lockfiles for local, URL and ZIP sources
- Persistent object cache and C/C++/assembly WASM compilation coverage
- A public custom-programmer protocol registry with simulated hardware tests
- Arduino-first project init and `.ino` sketch preprocessing with setup/loop and function prototypes
- Arduino, boards.txt, platform.txt, library.properties/library.json and PlatformIO INI parsers
- Versioned upstream Arduino core manifests and official board preset metadata
- Host-independent `@wicro/language-server` LSP/session primitives with clang WASI diagnostics and completion
- VS Code and Monaco language operations and generated `compile_commands.json` data
- Worker protocol support for browser/Node language isolation
- STM32F401RC Cortex-M4 bare-metal ELF/BIN reference fixture
- RISC-V WebAssembly compiler execution for ELF32 object generation
- ESP32-C3 SuperMini hardware discovery through USB-Serial/JTAG
- Native ESP-IDF v6.1.1 reference blink build and serial heartbeat observation on hardware
- Native USB VCP 1200-baud/DTR/RTS reset sequences in the programmer transport
- GPIO8 active-low LED, serial heartbeat and 4 MB flash detection on the native reference firmware
- Monaco browser IDE shell and Web Serial controls

## Quick start

Run the CLI without installation:

```sh
npx @jozo132/wicro --help
```

Or install it globally:

```sh
npm install -g @jozo132/wicro
wicro --help
wicro doctor --json
wicro device list --json
```

ESP32-C3 SuperMini commands:

```sh
wicro build --project=examples/esp32-c3-supermini/blink
wicro upload --project=examples/esp32-c3-supermini/blink --port=/dev/ttyACM0
wicro monitor --port=/dev/ttyACM0 --baud=115200
```

The ESP32-C3 test board uses USB-Serial/JTAG VID/PID `303a:1001`, GPIO8 for the active-low onboard blue LED and BOOT on GPIO9. The STM32F401RC second MVP fixture uses Cortex-M4 Thumb, flash origin `0x08000000`, SRAM origin `0x20000000`, and 256 KB flash / 96 KB SRAM.

## Arduino-first workflow

New projects default to the Arduino framework and an Arduino UNO preset:

```sh
wicro init my-sketch
wicro import --source=existing-project --dest=my-import --json
wicro platformio search fastled
wicro arduino library search fastled
wicro build --project=my-sketch --board=arduino-uno-original
```

Directory and ZIP project imports use data-only parsing and copy operations. No Arduino or PlatformIO installation script is executed.

## Board blink examples

- Arduino UNO original: `examples/arduino-uno-original/blink`
- Original ESP32: `examples/esp32-original/blink`
- ESP8266: `examples/esp8266/blink`
- RP2040: `examples/rp2040/blink`
- RP2350: `examples/rp2350/blink`
- ESP32-C3 SuperMini: `examples/esp32-c3-supermini/blink`
- STM32F401RC: `examples/stm32f401rc/bare-metal-blink`
- STM32F103CB: `examples/stm32f103cb/bare-metal-blink`
- STM32H723VG: `examples/stm32h723vg/bare-metal-blink`

## Browser IDE

```sh
npm run dev:web
```

Open `http://localhost:5173` in a Chromium-based browser (Chrome or Edge for Web Serial support). The browser IDE runs the complete canonical Wicro pipeline in a Web Worker:

- **Platform setup**: family/model/board filters, framework choices, optimization/debug/warning controls, defines, and conditional programmer/upload/verification settings, synchronized with the JSON editor. See [Visual platform configuration](docs/platform-configuration.md).
- **Project & editor**: multi-file project explorer, Monaco editor, canonical board/framework/example selectors from `registry/` and `examples/`, light/dark themes, and resizable panels.
- **Browser WASM build**: full `clang` + `ld.lld` compilation and linking via `BrowserLlvmWasmToolchain` and `createWicroEngine`, automatic SHA-256 verified toolchain and SDK acquisition, persistent OPFS caching, incremental object caching, offline rebuilds, structured compiler diagnostics, and Flash/RAM memory statistics.
- **Browser USB flashing & serial monitor**: `BrowserEsp32Programmer` (`esptool-js` over Web Serial) with application partition validation, optional flash readback verification, automatic hard reset, and coordinated `BrowserSerialMonitor` reconnection with timestamps, baud rate selection, pause/resume, copy/clear, and serial input.

Run browser automation E2E tests with:

```sh
node --test tests/web-ide.test.js
```

Remote browser acquisition has separate real CORS and cache tests: `npm run test:remote-assets`. Use `npm run check:remote-assets` for live upstream GET probes. Production builds reference registry artifact URLs and do not embed SDK/compiler binaries. Current upstream browser access blockers and deployment choices are documented in [Remote SDK and compiler assets](docs/remote-assets.md).

## Development

```sh
npm install
npm test
npm run check:types
npm run build:web
npm run pack:check
```

For ESP-IDF firmware work, the compiler is staged under `toolchain/llvm-wasm/cache`, while the ESP32-C3 framework and native reference environment are under `toolchain/esp32-c3/esp-idf`. Downloaded compiler, framework and build assets are ignored by Git; their manifests remain versioned in `registry/`.

SDK and package archives may be staged in `registry-cache/`. The filename convention is `<manifest-name>-<manifest-version>.zip`, for example `arduino-esp32-1.0.0.zip`. Local files are attempted before network mirrors, their SHA-256 identity is still verified, and `registry-cache/` is ignored by Git.

## Repository status

Remaining integration work:

- ESP-IDF/Pico SDK/CMSIS/Arduino SDK distributions must provide their complete headers, submodules, startup artifacts and core archives before full SDK firmware linking can be claimed; pinned AVR, ESP8266, STM32, Pico and Pico SDK archives now have verified SHA-256 identities
- Browser remote acquisition remains deployment-blocked: current source archive and LLVM release URLs fail Chromium CORS probes, and the ESP32-C3 SDK URL returns HTTP 404; development assets do not establish remote browser compatibility
- ESP32-C3 native USB VCP ROM entry is implemented but is not yet successful on the connected unit; physical flash/execution remains unverified
- Header dependency tracking and incremental relinking need project-wide cache integration
- ST-LINK, USB DFU/DfuSe, STM32 UART, AVR STK500 and PICOBOOT protocol implementations are public extension surfaces but are not yet hardware-verified
- Physical firmware verification is target-specific and must be reported separately from source and build success. ESP32-C3 ROM sync and application-only stub flashing are now physically verified on `/dev/ttyACM0`; direct CDC DTR/RTS reset re-enters ROM mode automatically

See [docs/compatibility.md](docs/compatibility.md) for the current implemented, planned and hardware-verified matrix.

## Unified LLVM / language tooling

The current cache contains a 57 MB Clang/LLD WASI multicall binary. It provides real Clang diagnostics, code-completion entry execution and ARM/AVR/RISC-V/Xtensa compilation; the pinned build recipe can include Clang-tools-extra and utility targets, but missing Clangd, Clang-Tidy, Clang-Format and LLVM utility `.wasm` artifacts are reported as unavailable and are never presented as implemented.

Run the Node benchmark with:

```sh
npm run benchmark:llvm
```

The generated report is [benchmarks/llvm-wasm-benchmark.json](benchmarks/llvm-wasm-benchmark.json). Browser and separate-Clangd benchmarks remain explicitly skipped until corresponding WASM artifacts exist and execute.

No package is published by repository scripts or tests. Public publishing requires separate explicit approval.
