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
| Browser host adapter | Implemented | Vite app with Monaco and Web Serial controls |
| VS Code host adapter | Planned | Native host adapter not implemented yet |
| WASM runtime | Verified | Espressif LLVM/LD WASM assets execute through Node WASI and compile ELF32 RISC-V objects |
| ESP32-C3 ESP-IDF package | Verified | ESP-IDF v6.1.1 builds and executes on a physical C3 SuperMini |
| C3 GPIO/serial blink | Verified | GPIO8 blink and USB serial heartbeat observed on hardware |
| ESP32-C3 flash size | Verified | 4 MB XMC flash detected through esptool |
| ESP32-C3 boot/partition layout | Verified | 0x0 bootloader, 0x8000 partition table, 0x10000 app |
| Browser WASI compile | Implemented | Monaco source compiles to in-memory ELF32 RISC-V main.o |
| Package URL/ZIP/local install | Implemented | URL, ZIP, local directory and SHA-256 tests |
| Incremental compilation/cache | Planned | Task DAG exists; source/header and object cache not complete |
| PlatformIO/Arduino/CMSIS registries | Planned | Registry adapter interface not implemented yet |
| Node serial discovery | Implemented | SerialPort detects Espressif VID/PID 303a:1001 |
| esptool-js Node programmer | Implemented | Targeted write, verification and ROM probe adapter |
| Brightness/PWM examples | Implemented | ESP-IDF builds produce RISC-V ELF/BIN artifacts; not physically validated yet |
| Serial hello/command examples | Implemented | ESP-IDF builds produce RISC-V ELF/BIN artifacts; not individually hardware-validated yet |
| Non-blocking timer example | Implemented | ESP-IDF build produces RISC-V ELF/BIN artifacts |
| External library example | Implemented | Custom ESP-IDF component build produces RISC-V ELF/BIN artifacts |
| Wi-Fi scan example | Implemented | ESP-IDF Wi-Fi build produces RISC-V ELF/BIN artifacts; no opt-in network test claim |
| VS Code extension | Planned | No application implementation |

Do not report compiler or hardware support as verified until it passes a real target test.
