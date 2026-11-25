# Original ESP32 LX6 hardware verification

The original ESP32 is physically verified for the shared engine's bare-metal,
RAM-only ROM firmware recipe. LLVM compiles C and Xtensa assembly in WASM; LLD
links the complete ELF in WASM. A shared JavaScript encoder generates the original
ESP32 ROM image. No native compiler, Python, native esptool or installed SDK is
required. This establishes PRO CPU firmware execution; the APP CPU remains in
reset. Arduino, ESP-IDF runtime integration, FreeRTOS, Wi-Fi, Bluetooth, PSRAM,
flash-mapped applications and multicore execution remain separate work.

## Physical evidence

On 25 November 2026 the connected board was `/dev/ttyUSB0`, with a CP2102 bridge
`10c4:ea60`. ROM interrogation identified **ESP32-D0WDQ6 revision 1**, MAC
`24:0a:c4:12:3f:a0`, a 40 MHz crystal and 4 MiB flash (JEDEC `0x1640c8`).
The bridge identifier alone does not establish the MCU model.

The public CLI built and uploaded a 528-byte image at `0x1000`, verified every
byte through readback and automatically reset the board. The opt-in acceptance
test observed one startup banner and 87 consecutive heartbeat counters over a
65-second run, with a 64,492 ms observed heartbeat span, maximum gap 751 ms and
no detected exception/reset. The offline rebuild was byte-identical. SHA-256:
`784756bbd79506fc2814c41c95ba147f67e86cd71d1b2240741e5f7bd02c53e8`.

The original first 64 KiB was saved locally before writing. A physical comparison
after upload confirmed `[0,0x1000)` and `[0x2000,0x10000)` remained unchanged;
the replaced erase sector is `[0x1000,0x2000)`. These checks do not claim a backup
or comparison of the remaining flash. Raw backup and acceptance evidence remain
ignored under `.wicro/esp32-original` and `.wicro/hardware`.

Node/browser WASI tests compare ELF and BIN bytes and independently parse the
image with esptool-js. Real Chromium builds the example and validates its platform
controls. Browser hardware upload is implemented through Web Serial and the same
flashing engine, but has not been physically verified. No GPIO/LED or second-core
operation is claimed by the UART test.

## Build and upload

```sh
node packages/wicro/bin/wicro.js build --project=examples/esp32-original/bare-metal-heartbeat
node packages/wicro/bin/wicro.js upload --project=examples/esp32-original/bare-metal-heartbeat \
  --port=/dev/ttyUSB0 --mac=24:0a:c4:12:3f:a0
node packages/wicro/bin/wicro.js monitor --port=/dev/ttyUSB0 --baud=115200
```

Use the actual port and MAC for your board. An explicit port is required; the MAC
is optional for ordinary uploads and required by the hardware acceptance test.
The UART upload path uses the board's standard DTR/RTS auto-reset circuit.

In `npm run dev:web`, choose **esp32-original/bare-metal-heartbeat**, build and
Flash, then select the board's serial bridge. The profile has a fixed 115200 baud
upload and mandatory byte-for-byte readback. JSON edits and visual configuration
share the same board/platform recipe. The existing `esp32-original` and
`esp32-devkit` Arduino presets remain separate object-build presets.

For an explicit binary, use `upload --programmer=esp32-original-uart --bin=...
--port=... --mac=...`. The uploader checks the actual ROM chip, optional MAC,
40 MHz crystal and 4 MiB flash before writing. It reads the flash-encryption count
and both secure-boot eFuse bits and rejects enabled security modes; it never
burns eFuses or changes security state.

**This recipe replaces the existing second-stage bootloader at `0x1000`.** It runs
directly after ROM loading, bypassing the partition table and existing SDK app.
The encoder only accepts bounded IRAM/DRAM segments, an entry within executable
IRAM, original ESP32 chip ID, DIO/40 MHz/4 MiB header, checksum and zero padding.
The BIN must fit before `0x8000`. Upload erases only the occupied 4 KiB sectors,
so bytes after the image within the final sector are also replaced. No whole-chip
erase or partition-table write is issued.

The startup reserves a private stack, masks interrupts, clears BSS and disables
the boot watchdogs. The runtime polls UART0 and preserves the ROM's clock and UART
configuration. No adjustable CPU clock, interrupt handler framework or RTOS is
provided by this example.

## Reproduce acceptance

```sh
WICRO_ESP32_ORIGINAL_HARDWARE=1 \
WICRO_ESP32_ORIGINAL_PORT=/dev/ttyUSB0 \
WICRO_ESP32_ORIGINAL_MAC=24:0a:c4:12:3f:a0 \
node --test tests/esp32-original-hardware.test.js
```

This opt-in test replaces the selected board's boot image. Normal test runs skip
hardware writes. The acceptance test covers CLI upload, readback, a hardware
reset, sustained real UART counters and cached offline compilation; the original
64 KiB backup/preservation comparison was an additional manual verification.

References: [Espressif startup flow](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-guides/startup.html),
[ESP32 firmware image format](https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/firmware-image-format.html),
[Espressif register definitions](https://github.com/espressif/esp-idf/tree/master/components/soc/esp32/register/soc).
