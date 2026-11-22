# Arduino ecosystem status

Wicro uses Arduino as the default framework for new projects. The implementation is shared across the browser, Node.js CLI and VS Code hosts.

## Implemented

- `.ino` preprocessing with automatic `Arduino.h`, setup/loop prototypes and generated function prototypes.
- Multiple sketch tabs and generated C++ source mapping.
- C, C++ and assembly input through the existing LLVM WASI runtime.
- Bare-metal C++ ELF/BIN linking with an explicit C-linkage `main` entry for startup-based targets.
- Incremental object cache keys for generated Arduino C++ and SDK/compiler identity.
- Every project C, C++ and assembly source is compiled for object builds.
- `compile_commands.json` is generated for project source entries.
- `boards.txt`, `platform.txt`, `library.properties`, `library.json` and `platformio.ini` parsing.
- Library discovery and missing-header reporting.
- Directory and ZIP project import.
- PlatformIO registry search and INI import.
- Arduino Board/Library Manager URL adapters with browser CORS diagnostics.

## Preset manifests

The registry contains AVR, ESP32, ESP8266, STM32 and Pico preset metadata for UNO, Nano, Mega, Leonardo, ESP32-C3/DevKit/S2/S3/C6/H2, ESP8266 NodeMCU/D1 Mini, Blue/Black Pill, Nucleo-F401RE, Pico W, Pico 2 and Pico 2 W.

## On-demand SDK policy

Framework distributions are declared in immutable package manifests with pinned upstream commits or tags. SDK ZIP archives are downloaded only on first use, extracted into the OS/user cache or browser OPFS/IndexedDB cache, locked with SHA-256 and file hashes, and reused offline. Repository test environments may use `registry-cache/<manifest-name>-<manifest-version>.zip` as a first-source local archive pool. SDK sources, extracted vendor trees, core archives and toolchain binaries are not committed to Git or included in npm archives.

## Pinned upstream sources

| Core | Repository | Resolved head |
|---|---|---|
| AVR | https://github.com/arduino/ArduinoCore-avr | `11b9130371e8447920edb65a75706a6c951e51fc` |
| ESP32 | https://github.com/espressif/arduino-esp32 | `bc8ab15634eb0402d39e1e259a5a4a29be3e6e1c` |
| ESP8266 | https://github.com/esp8266/Arduino | `7d5a4cec8f4639177995bd15f583a922ecd2f793` |
| STM32 | https://github.com/stm32duino/Arduino_Core_STM32 | `8c9c3758cf4a732fef6cdc07c5da337e381312e5` |
| Pico | https://github.com/earlephilhower/arduino-pico | `83f7b6e5ab9988164f4a291ee6d5c3bcd0e03cdf` |

These heads are recorded for reproducibility. The pinned Arduino-ESP32 Codeload archive has a validated 84 MB ZIP and SHA-256 `52bd9b2feefdcc1e9c929f7b57f87faec687e7fbfeee5199f750d3f34f9a33cd`. It contains the ESP32 core and ESP32-C3 variant. ESP-IDF, compiler CDNs and complete precompiled Arduino core archives still require separate complete distributions before firmware linking is claimed.

## Explicitly pending

- Complete upstream core and variant archive distributions.
- Board variant headers and pin mappings backed by installed SDK packages.
- Precompiled core archive linking for every preset.
- Official Arduino board/platform index downloads into persistent offline caches.
- C library archive ABI validation against official Arduino toolchains.
- Physical flash and execution verification beyond the existing ESP32-C3 native ESP-IDF tests.
- Compiler CDN URLs and genuine release assets for the LLVM WASM binaries.
- ESP-IDF source distributions that include required submodules and toolchain components.
- Complete WASM-ABI-compatible core/archive linkage for bootable Arduino firmware. Native PlatformIO reference builds have been verified, but WASM compilation of the real Arduino sketch is blocked by staged sysroot coverage and WASI memory limits with large archive inputs.

No native Arduino, PlatformIO, Make or CMake command is executed by the Wicro build engine.
