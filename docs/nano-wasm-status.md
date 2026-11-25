# Arduino Nano ATmega328P

The CH340 Nano is physically verified with genuine Arduino AVR code compiled and
linked entirely using LLVM/LLD WASM. The normal shared engine supports its `.ino`
project; no native compiler or avrdude is executed. Node/CLI upload uses a shared
STK500v1 implementation; browser Web Serial uses the same protocol engine.

## Physical evidence

On 25 November 2026 the Nano was `/dev/ttyUSB1` (CH340 `1a86:7523`). Its bootloader
responded at 115200 baud, reported version 4.4, and returned ATmega328P signature
`1e950f`. The original complete 32 KiB flash was backed up locally before writing.
The bootloader's presence and signature were established through the protocol,
not inferred from the USB bridge identifier.

The shared-engine 3,458-byte firmware passed page-by-page readback, preserved the
upper 2 KiB bootloader region byte-for-byte, and produced 130 serial heartbeats
across a 65-second stable window with zero unexpected application boots. Its SHA-256
is `6d288593f3ebb4c9122783902e4142eca357f58305899606865e3974acbe0811`.
An offline rebuild was byte-identical. The sketch runs actual Arduino Serial,
digitalWrite and delay; visual LED operation was not observed. Opening the serial
port can reset the Nano, so stability measurement starts after host line-control
changes settle. Raw results are ignored under `.wicro/nano`.

Real Chromium also built the Nano Arduino example and exercised bootloader-speed
controls. Browser hardware uploading has not been physically verified.

## Development setup and use

```sh
# Requires genuine cached PlatformIO AVR framework 5.4.0 and AVR toolchain
# 1.70300.191015 under ~/.platformio/packages; only their data is consumed.
node scripts/package-nano-sdk.js
node packages/wicro/bin/wicro.js build --project=examples/arduino-nano/heartbeat
node packages/wicro/bin/wicro.js upload --project=examples/arduino-nano/heartbeat \
  --port=/dev/ttyUSB1 --baud=115200
node packages/wicro/bin/wicro.js monitor --port=/dev/ttyUSB1 --baud=115200
```

The SDK packager copies genuine Arduino core/variant files, AVR headers and the
AVR5 CRT/libc/libm/libgcc/device runtime. It excludes native executables and writes
a deterministic, checksum-pinned ZIP under `dist/assets`. Node installs it into
persistent SDK storage; `npm run dev:web` serves it as an explicit development
asset, and the browser caches it in OPFS. No SDK/archive/compiler binary is
committed or published. The manifest intentionally has no fabricated remote URL:
**cold production SDK acquisition remains pending a configured distribution**.
This is separate from the deferred work on general dependency resolution.

In the website select **arduino-nano/heartbeat**. Choose upload baud 115200 for the
verified board; 57600 is exposed for old Nano bootloaders but was not tested on
this device. CH340 identifies a serial bridge, so choose the correct physical
port. Full ATmega328P signature checking happens before flash writes.

For an explicit binary use `upload --programmer=stk500v1 --board=arduino-nano
--port=... --bin=... --baud=115200`. Only AVR reset-vector images within 30 KiB are
accepted. Upload operates in 128-byte pages, reads every page back, and never
issues chip erase, EEPROM, fuse or bootloader programming commands. Padding in a
partially used last page is programmed to 0xff.

## Reproduce hardware acceptance

```sh
WICRO_NANO_HARDWARE=1 WICRO_NANO_PORT=/dev/ttyUSB1 \
node --test tests/nano-hardware.test.js
```

This opt-in command modifies application flash on the explicitly selected Nano.
Normal tests skip hardware writes. The test compares bootloader bytes before and
after, verifies actual application output and performs an offline rebuild.

## LLVM compatibility scope

The Nano recipe selects the non-USB core sources; it does not enable Leonardo
USB support. The linker includes real CRT startup and constructor tables and
places initialized SRAM data at its flash load address. Vendor debug sections
using unsupported AVR debug relocations are discarded. `PROVIDE` preserves the
upstream optional `serialEvent` null reference when absent, while permitting a
user definition. This addresses the current LLVM AVR undefined-weak emission;
no replacement serial implementation or dummy runtime is used.

Additional boards, Arduino libraries and hardware peripherals need their own
coverage. Complete generic AVR SDK/dependency discovery is not claimed.

References: [Microchip STK500v1 protocol](https://ww1.microchip.com/downloads/en/AppNotes/doc2525.pdf),
[Arduino Nano bootloader selection](https://support.arduino.cc/hc/en-us/articles/4401874304274-Select-the-right-processor-for-Arduino-Nano).
