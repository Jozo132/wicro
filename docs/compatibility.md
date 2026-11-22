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
| Browser host adapter | Implemented | Vite app with Monaco target selection, target-specific WASM compile, Web Serial monitor and Espressif ESPLoader upload |
| VS Code host adapter | Implemented | `@wicro/vscode` provides board listing, compile, bare-metal link and device command surfaces |
| WASM runtime | Verified | One shared LLVM/LD WASM package executes ARM, AVR, RISC-V 32/64 and Xtensa targets through Node WASI and links STM32 ELF/BIN images |
| ESP32-C3 ESP-IDF package | Native reference verified | ESP-IDF v6.1.1 native reference blink serial heartbeat observed on a physical C3 SuperMini; native app-only flash/readback verified; complete Arduino/WASM build remains pending |
| Arduino-ESP32 external distribution | Implemented/validated archive | Pinned commit archive installs, verifies and reuses cache content; ESP32-C3 variant and `Arduino.h` are present; complete firmware linking remains unverified |
| Compiler CDN distribution | Implemented infrastructure/blocked deployment | SHA-verified cache, mirror fallback and bounded retries are implemented; compiler release URLs/checksums require explicit deployment |
| ESP32-C3 USB ROM flashing | Verified ROM sync and application flash | Wicro ROM sync, 4 MB flash detection, stub upload and app-only write to 0x10000 verified; readback matches the known-good ESP-IDF image byte-for-byte |
| ESP32-C3 automatic reset | Implemented and verified direct CDC reset | Exact USB-JTAG DTR/RTS CDC pulse sequence detaches the kernel driver, enters ROM download mode and resynchronizes; manual BOOT/RESET is no longer required |
| ESP32-C3 ELF-to-application image | Implemented and structurally verified | WAsm runtime emits a 24-byte ESP32-C3 header, load segments, checksum and SHA-256 digest; native esptool parses the generated reference ELF image and reports valid segment layout and footer |
| Native Arduino-ESP32 reference build | Verified external reference | PlatformIO built a real ESP32-C3 Arduino firmware ELF (6,041,556 bytes) and BIN (270,640 bytes); this is reference evidence, not Wicro WASM compilation |
| Complete Arduino-ESP32 WASM firmware | Planned/blocked | Wicro's generic WASM LLD link now accepts staged objects, archives and linker scripts, and can emit ELF objects; complete hosted sysroot, C++ runtime and ESP-IDF archive linking remain unresolved |
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
| Clean npm archive | Verified | The packed CLI is 33.8 kB, installs in a temporary directory, runs `npx wicro --help`, and contains no `.wasm`, SDK archive or extracted SDK tree |
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
| Complete Arduino SDK firmware linking | Planned | Arduino core archives, board variants, full headers, startup and linker distributions are not yet shipped in the package cache |
| boards.txt/platform.txt parsing | Implemented | Property-file parsing, board names, menu options and platform INI parsing are executable and tested |
| library.properties/library.json parsing | Implemented | Arduino and PlatformIO library metadata parsing is executable and tested |
| PlatformIO import/search | Implemented | PlatformIO INI parsing and registry lookup are available; script execution is prohibited |
| Arduino Board/Library Manager | Implemented | Official index URLs and browser CORS diagnostics are implemented; cached/offline distribution remains separate |

## Target verification matrix

| Target | Source availability | WASM compile | Firmware link/artifact | Flash protocol | Physical execution |
|---|---|---|---|---|---|
| ESP32-C3 | Implemented; ESP-IDF 6.1.1 project | RISC-V object compile verified | ESP-IDF native reference ELF/BIN builds verified; complete Arduino/WASM SDK link pending | Native USB JTAG reset, ROM sync and app-only flash verified; bootloader/partition preserved | Native ESP-IDF application flash and byte-for-byte readback verified; USB console execution remains target-specific |
| Original ESP32 | Implemented | Xtensa object compile implemented | Native ESP-IDF source and build setup present; complete WASM link pending | ESPTool implemented | Not physically verified |
| ESP8266 | Implemented | Xtensa object compile implemented | SDK and startup/link artifacts pending | Protocol surface pending | Not physically verified |
| Arduino UNO / ATmega328P | Implemented | AVR object compile verified | Link/HEX generation pending | AVR STK500 protocol not yet hardware-verified | Not physically verified |
| STM32F103CB | Implemented bare-metal fixture | Cortex-M3 object and ELF/BIN linking verified | ELF/BIN verified through WASM | ST-LINK/STM32 UART/DfuSe not yet hardware-verified | Native fixture only; no physical claim |
| STM32F401RC | Implemented bare-metal fixture | Cortex-M4 object compile and linker recipe present | ELF/BIN linking needs repeated WASM fixture execution | ST-LINK/STM32 UART/DfuSe not yet hardware-verified | Not physically verified |
| STM32H723VG | Implemented bare-metal fixture | Cortex-M7 object compile/ELF/BIN linking verified | ELF/BIN verified through WASM | ST-LINK/STM32 UART/DfuSe not yet hardware-verified | Native fixture only; no physical claim |
| RP2040 | Implemented fixture/source | Cortex-M0+ object compile verified | UF2/BIN/SKD linker artifacts pending | PICOBOOT protocol not yet hardware-verified | Not physically verified |
| RP2350 | Implemented fixture/source | Cortex-M33 object compile verified | UF2/BIN/SKD linker artifacts pending | PICOBOOT protocol not yet hardware-verified | Not physically verified |

Do not report compiler or hardware support as verified until it passes a real target test.
