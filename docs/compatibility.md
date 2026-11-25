# Wicro compatibility matrix

Status values:

- **Implemented**: covered by executable code and automated tests.
- **Planned**: designed in public interfaces or CLI routing, but not implemented.
- **Verified**: implemented and validated against real external hardware or toolchains.

| Area | Status | Current evidence |
|---|---|---|
| Monorepo workspaces | Implemented | npm workspaces and private workspace packages |
| Strict JSDoc typing | Implemented | `npm run check:types` |
| Package manifest validation | Implemented | AJV 2020 schema tests |
| Semantic version resolution | Implemented | SemVer registry tests |
| Virtual filesystem | Implemented | MemoryFilesystem tests |
| Build DAG scheduling | Implemented | Cycle and parallel-layer tests |
| CLI `init` | Implemented | CLI integration tests |
| CLI `clean` / `doctor` | Implemented | CLI integration tests |
| Machine-readable CLI output | Implemented | JSON output tests |
| Canonical platform architecture | Implemented and verified | `WicroPlatformRegistry` abstracts architectures, platforms, boards, frameworks, firmware formats (`elf`, `bin`, `hex`, `uf2`, `esp32-c3-bin`) and programmers with zero vendor hardcoding in `@wicro/core`; validated on both `espressif-esp32c3` (RISC-V Arduino) and `st-stm32-bare-metal` (ARM Cortex-M3) |
| Automatic SDK & compiler distribution | Implemented and tested | Atomic staged extraction, Web Crypto SHA-256 verification, mirror fallback/retries, concurrent deduplication, SHA-based invalidation, cross-project OS cache (`~/.cache/wicro`) and `--offline` mode; reproducible packager in `scripts/package-esp32-c3-sdk.js` |
| Node.js & Browser WASI parity | Verified | `LlvmWasmToolchain` (Node WASI) and `BrowserLlvmWasmToolchain` (`@bjorn3/browser_wasi_shim`) produce byte-for-byte identical STM32F103CB ELF, BIN, HEX and UF2 firmware through the shared `@wicro/core` engine |
| Browser host adapter | Implemented | Vite app with Monaco target selection using shared `resolveArchitectureTargetArgs()`, target-specific WASM compile, Web Serial monitor and Espressif ESPLoader upload |
| VS Code host adapter | Implemented | `@wicro/vscode` provides board listing, compile, bare-metal link and device command surfaces |
| WASM runtime | Verified | One shared LLVM/LD WASM package executes ARM, AVR, RISC-V 32/64 and Xtensa targets through Node WASI and links STM32 ELF/BIN images |
| ESP32-C3 ESP-IDF package | Verified | ESP-IDF v6.1.1 native reference and ESP32-C3 Arduino-ESP32 WASM-linked firmware both verified on physical ESP32-C3 SuperMini |
| Arduino-ESP32 external distribution | Verified | Pinned commit archive installs, verifies and reuses cache content; ESP32-C3 variant, `Arduino.h`, core sources and SDK archives link cleanly through WASM LLD |
| Compiler CDN distribution | Implemented infrastructure/blocked deployment | SHA-verified cache, mirror fallback and bounded retries are implemented; compiler release URLs/checksums require explicit deployment |
| ESP32-C3 USB ROM flashing | Verified ROM sync, app flash and readback | Wicro ROM sync, 4 MB flash detection, stub upload, app-only write to `0x10000`, and byte-for-byte readback verified for both native reference and WASM-built firmware |
| ESP32-C3 automatic reset | Verified | Direct USB-JTAG CDC SET_CONTROL_LINE_STATE download-entry and hard-reset sequences work reliably without manual BOOT/RESET buttons |
| ESP32-C3 ELF-to-application image | Verified (byte-for-byte esptool parity) | Wicro `elfToEsp32Bin()` uses section-based segment merging, 64 KB MMU page alignment for DROM/IROM, `app_elf_sha256` population, XOR checksum and SHA-256; matches official esptool output byte-for-byte and passes independent `validateEsp32Image()` checks |
| Native Arduino-ESP32 reference build | Verified external reference | PlatformIO built a reference ESP32-C3 Arduino ELF (6,041,556 bytes) and BIN (270,640 bytes) used for ELF/BIN parity verification |
| Complete Arduino-ESP32 WASM firmware | Verified | Genuine Arduino `.ino` sketch compiles with `llvm.wasm clang`, links with `llvm.wasm ld.lld` (zero weak stubs, zero native fallback), generates a 246,880-byte valid ESP32-C3 BIN, flashes to `0x10000` with readback verification, outputs `WICRO_SERIAL_READY` and `LED ON`/`LED OFF` over USB Serial/JTAG, blinks GPIO8, and passes a 65-second continuous stability acceptance test plus offline cached rebuild |
| Original ESP32 native example | Source implemented | ESP-IDF project is present; native build requires `xtensa-esp32-elf-gcc` on PATH |
| ESP8266 native example | Source implemented | Arduino `.ino` example is present; native build requires `arduino-cli` and the ESP8266 core |
| STM32 bare-metal fixtures | Verified | STM32F401RC native Cortex-M4 ELF/BIN, STM32F103CB native Cortex-M3 ELF/BIN and STM32H723VG native Cortex-M7 ELF/BIN fixtures build with ARM GCC |
| C3 GPIO/serial blink | Verified | GPIO8 blink and USB serial heartbeat observed on hardware |
| ESP32-C3 flash size | Verified | 4 MB XMC flash detected through esptool |
| ESP32-C3 boot/partition layout | Verified | 0x0 bootloader, 0x8000 partition table, 0x10000 app |
| Shared LLVM WASM compiler | Verified | One 57 MB binary exposes ARM, AVR, RISC-V 32/64 and Xtensa; target sysroots and full firmware linking remain separate work |
| Browser WASI compile | Implemented | Monaco source compiles to in-memory ELF32 RISC-V main.o |
| Package URL/ZIP/local install | Implemented | URL, ZIP, local directory and SHA-256 tests |
| Incremental compilation/cache | Implemented (object cache) | Runtime cache keys source, target, options and include files; project-wide header dependency tracking remains |
| PlatformIO/Arduino/CMSIS registries | Partial | PlatformIO search/lookup adapter implemented; complete Arduino/CMSIS SDK distributions remain separate |
| Node serial discovery | Implemented | SerialPort detects Espressif VID/PID 303a:1001 |
| esptool-js Node programmer | Implemented and hardware-verified | USB-JTAG CDC reset, ROM sync, stub upload, app-only 0x10000 write and byte-for-byte readback are verified on the connected C3 SuperMini |
| Brightness/PWM examples | Implemented | ESP-IDF builds produce RISC-V ELF/BIN artifacts; not physically validated yet |
| Serial hello/command examples | Implemented | ESP-IDF builds produce RISC-V ELF/BIN artifacts; not individually hardware-validated yet |
| Non-blocking timer example | Implemented | ESP-IDF build produces RISC-V ELF/BIN artifacts |
| External library example | Implemented | Custom ESP-IDF component build produces RISC-V ELF/BIN artifacts |
| Wi-Fi scan example | Implemented | ESP-IDF Wi-Fi build produces RISC-V ELF/BIN artifacts; no opt-in network test claim |
| Board blink examples | Implemented | Arduino UNO, original ESP32, ESP8266, RP2040, RP2350, ESP32-C3, STM32F401RC, STM32F103CB and STM32H723VG source packages are present; only currently documented hardware fixtures are runtime-verified |
| C, C++ and assembly WASM compile | Verified | Node WASI tests compile C, C++, and assembly with the shared LLVM WASM binary |
| Persistent object cache | Implemented | The runtime cache keys source, target, options and include files; cache hits are automated and executable |
| Package install/remove/update | Implemented | CLI install, uninstall and update commands use registry manifests, cache directories and `.wicro/wicro-lock.json` |
| Custom URL/ZIP/local packages | Implemented | URL and local ZIP/directory installer tests cover SHA-256 verification and virtual/disk installs |
| Transitive dependencies | Implemented | SemVer registry resolution returns and detects dependency conflicts in a package tree |
| PlatformIO registry integration | Implemented | Public PlatformIO search/package lookup adapter uses configurable fetch and HTTP contracts |
| Programmer extension API | Implemented | `ProgrammerProtocolRegistry` supports custom named protocols; the simulated protocol is automated-tested |
| Clean npm archive | Verified | The packed CLI dry run is 111.6 kB and contains no `.wasm`, SDK archive or extracted SDK tree; CLI tests exercise its command surfaces |
| Real Clang WASI diagnostics | Implemented | Existing LLVM WASM binary executes `-fsyntax-only` and returns parsed Clang diagnostics |
| Clang WASI code completion | Implemented | Existing LLVM WASM binary executes `-code-completion-at` and returns parsed candidates |
| `@wicro/language-server` LSP/session | Implemented | LSP initialization, document sync, diagnostics, completion, hover, definition, references, rename and formatting protocol are executable in tests |
| VS Code language operations | Implemented | Board host adapter exposes diagnostics, completion, hover, definition, references, rename and compile-commands surfaces |
| Browser/Node worker isolation | Implemented | Host-independent worker protocol and Monaco browser WASI adapter exist; background worker threads remain separate implementation work |
| Clangd WASM | Planned/blocked | No clangd.wasm artifact exists in the cache; upstream threads are disabled for WASI preview1 compatibility |
| Clang-Tidy/Format WASM | Planned/blocked | Entry points are defined but no executable WASM artifacts exist in the cache |
| LLVM utility WASM entry points | Planned/blocked | llvm-ar, objcopy, objdump, size, nm and readelf artifacts are not present |
| Unified WASM build recipe | Implemented | Pinned esp-wasm and Espressif LLVM revisions enable clang-tools-extra and utility targets; combined-result runtime parity is not yet benchmarked |
| Node LLVM benchmark | Verified | Repeated real WASI measurements are written to `benchmarks/llvm-wasm-benchmark.json`; missing tool categories are explicitly skipped |
| Browser LLVM compile benchmark | Verified | Chromium fetched and compiled the 57 MB LLVM WASM in repeated in-page measurements; data is recorded in the benchmark JSON |
| Arduino `.ino` preprocessing | Implemented | Shared parser adds Arduino.h, setup/loop prototypes and function prototypes for one or multiple tabs with generated-line source mapping |
| Arduino bare-metal C++ ELF/BIN | Implemented | Shared LLVM WASM runtime links C++ setup/loop code with startup and linker script using C-linkage `main` |
| Arduino SDK manifests | Implemented | AVR, ESP32, ESP8266, STM32 and Pico upstream revisions are recorded in versioned framework packages |
| Official Arduino board presets | Implemented | UNO, Nano, Mega, Leonardo, ESP32 families, ESP8266 NodeMCU/D1 Mini, STM32 boards and Pico variants are registered; SDK artifacts remain separate |
| Complete Arduino SDK firmware linking | ESP32-C3, Nano, F103C8 and F401RC verified | Genuine WASM firmware and physical execution; [STM32 Arduino](stm32-arduino.md) includes shared Web/CLI/VS Code parity, on-demand composition, CDC and F401 CDC-DFU. Other presets require separate integration and verification. |
| boards.txt/platform.txt parsing | Implemented | Property-file parsing, board names, menu options and platform INI parsing are executable and tested |
| library.properties/library.json parsing | Implemented | Arduino and PlatformIO library metadata parsing is executable and tested |
| PlatformIO import/search | Implemented | PlatformIO INI parsing and registry lookup are available; script execution is prohibited |
| Arduino Board/Library Manager | Implemented | Official index URLs and browser CORS diagnostics are implemented; cached/offline distribution remains separate |

## Target verification matrix

| Target | Native reference | WASM object compile | WASM-native firmware link | Flash & readback | Physical firmware execution |
|---|---|---|---|---|---|
| ESP32-C3 | Verified (PlatformIO 6,041,556 B ELF / 270,640 B BIN) | Verified (`llvm.wasm clang`) | Verified (`llvm.wasm ld.lld`, 12,779,432 B ELF / 246,880 B BIN, zero weak stubs, byte-for-byte esptool image parity) | Verified (auto USB-JTAG ROM entry, app-only `0x10000` write, byte-for-byte readback, hard reset) | Verified (`WICRO_SERIAL_READY`, `LED ON`/`LED OFF`, GPIO8 blink, 65 s continuous run with zero resets, offline cached rebuild) |
| Original ESP32 / ESP32-D0WDQ6 | Arduino/ESP-IDF source present | Verified Xtensa LX6 WASM | Verified RAM-only bare-metal ELF/BIN; Arduino/ESP-IDF recipe pending | Verified Node/CLI UART auto-reset, 0x1000 boot-image write and complete readback | Verified 65-second UART run with consecutive counters; second core, wireless, GPIO and browser hardware path unverified |
| ESP8266 | Arduino source present | Verified Xtensa/L106 WASM | Verified RAM-only bare-metal ELF/ROM image; Arduino SDK pending | Verified Node UART auto-reset, offset-0 write and complete readback | Verified UART heartbeat/stability; Wi-Fi and browser hardware path unverified |
| Arduino Nano / ATmega328P | Genuine Arduino AVR runtime | Verified | Verified Arduino ELF/BIN with WASM LLVM/LLD | Verified STK500v1 at 115200, page readback and preserved bootloader | Verified 65-second serial stability; browser hardware path unverified |
| Arduino UNO / ATmega328P | Source present | Verified object compiler | SDK recipe not enabled for UNO | Not hardware-verified | Not physically verified |
| STM32F103CB | Verified bare-metal fixture | Verified | Verified bare-metal ELF/BIN | ST-LINK/UART not hardware-verified | Not physically verified |
| STM32F103C8 (reported 64 KiB target) | Bare-metal SWD diagnostic source | Verified Cortex-M3 WASM | Verified bare-metal ELF/BIN/HEX | Verified Node/CLI JavaScript ST-Link, 1 KiB page erase, complete readback and reset/run | Verified live SRAM challenges and GPIO output registers; PB2 LED blink and real-browser ST-Link flashing confirmed by user; target USB firmware unverified |
| STM32F401RC | Verified bare-metal fixture | Verified | Verified STM32duino CDC-DFU development fixture (WASM LLVM/LLD, 27,672 B BIN) | Verified Node CDC → ROM DfuSe → write/readback → CDC | Verified USB heartbeat; browser hardware path and visual LED operation unverified |
| STM32H723VG | Verified bare-metal fixture | Verified | Verified bare-metal ELF/BIN | ST-LINK/UART not hardware-verified | Not physically verified |
| RP2040-Zero | Bare-metal USB source | Verified | Verified bare-metal ELF/BIN/UF2; Arduino/Pico SDK pending | Verified Node/CLI PICOBOOT, complete image readback and runtime-to-ROM re-upload | Verified 130 USB challenges over 65 seconds; browser hardware, UF2 drive copy and RGB LED unverified |
| Other RP2040 boards | Source/presets present | Verified object compiler | Board recipes pending | Not hardware-verified | Not physically verified |
| RP2350 | Source present | Verified | Pending | PICOBOOT not hardware-verified | Not physically verified |

Do not report compiler or hardware support as verified until it passes a real target test.

See [F401RC CDC-DFU](stm32-cdc-dfu.md) for physical evidence, browser limitations, hook translation and reproduction commands.

See [STM32F103C8 ST-Link](stm32f103-stlink.md) for reported C8/CB capacity, the PB2 variant, physical SWD evidence and browser debugging scope.

See [ESP8266 WASM hardware status](esp8266-wasm-status.md) for the verified 4 MiB/26 MHz bare-metal profile and its separate Arduino SDK limitations.

See [original ESP32 WASM status](esp32-original-wasm-status.md) for the verified 4 MiB/40 MHz bare-metal LX6 profile, bootloader replacement and separate Arduino/ESP-IDF scope.

See [Nano Arduino WASM status](nano-wasm-status.md) for verified scope and the pending cold production SDK distribution.

See [RP2040-Zero WASM status](rp2040-wasm-status.md) for bare-metal USB evidence and the separate Arduino/Pico SDK scope.

## STM32 Arduino integration

See [STM32 Arduino support](stm32-arduino.md) for exact F103C8/F401RC build, hardware and transport coverage. Production static browser cold downloads require a configured relay; the supplied relay is tested but not deployed.
