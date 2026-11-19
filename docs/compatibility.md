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
| ESP32-C3 ESP-IDF package | Verified | ESP-IDF v6.1.1 builds and executes on a physical C3 SuperMini |
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
| esptool-js Node programmer | Implemented | Targeted write, verification and ROM probe adapter |
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
| Clean npm archive | Verified | The packed CLI installs in a temporary directory and runs `doctor` and `board list` without repository paths |

## Target verification matrix

| Target | Source availability | WASM compile | Firmware link/artifact | Flash protocol | Physical execution |
|---|---|---|---|---|---|
| ESP32-C3 | Implemented; ESP-IDF 6.1.1 project | RISC-V object compile verified | ESP-IDF ELF/BIN builds verified in native reference; complete WASM SDK link pending | ESPTool Node/browser implemented; C3 flash verified | GPIO/serial blink verified on C3 SuperMini |
| Original ESP32 | Implemented | Xtensa object compile implemented | Native ESP-IDF source and build setup present; complete WASM link pending | ESPTool implemented | Not physically verified |
| ESP8266 | Implemented | Xtensa object compile implemented | SDK and startup/link artifacts pending | Protocol surface pending | Not physically verified |
| Arduino UNO / ATmega328P | Implemented | AVR object compile verified | Link/HEX generation pending | AVR STK500 protocol not yet hardware-verified | Not physically verified |
| STM32F103CB | Implemented bare-metal fixture | Cortex-M3 object and ELF/BIN linking verified | ELF/BIN verified through WASM | ST-LINK/STM32 UART/DfuSe not yet hardware-verified | Native fixture only; no physical claim |
| STM32F401RC | Implemented bare-metal fixture | Cortex-M4 object compile and linker recipe present | ELF/BIN linking needs repeated WASM fixture execution | ST-LINK/STM32 UART/DfuSe not yet hardware-verified | Not physically verified |
| STM32H723VG | Implemented bare-metal fixture | Cortex-M7 object compile/ELF/BIN linking verified | ELF/BIN verified through WASM | ST-LINK/STM32 UART/DfuSe not yet hardware-verified | Native fixture only; no physical claim |
| RP2040 | Implemented fixture/source | Cortex-M0+ object compile verified | UF2/BIN/SKD linker artifacts pending | PICOBOOT protocol not yet hardware-verified | Not physically verified |
| RP2350 | Implemented fixture/source | Cortex-M33 object compile verified | UF2/BIN/SKD linker artifacts pending | PICOBOOT protocol not yet hardware-verified | Not physically verified |

Do not report compiler or hardware support as verified until it passes a real target test.
