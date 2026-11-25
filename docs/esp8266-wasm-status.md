# ESP8266 hardware verification

The connected ESP8266EX is verified for Wicro's **bare-metal RAM-only firmware**
recipe. This is separate from the existing Arduino ESP8266/NodeMCU/D1 Mini
presets, whose complete SDK firmware linking remains pending. Wi-Fi, networking,
Arduino APIs, OTA and mapped-flash application images are not provided by this
recipe.

## Verified hardware and evidence

The 25 November 2026 test used `/dev/ttyUSB0`, a CH340 bridge (`1a86:7523`),
ESP8266 MAC `ac:0b:fb:dc:d2:43`, flash JEDEC ID `0x164068`, 4 MiB flash and a
26 MHz crystal. The USB bridge ID alone does not identify an ESP8266; the uploader
checks the chip through its ROM protocol before erasing flash.

The shared engine compiles the actual C application and assembly startup with
LLVM WASM and links with WASM LLD. Its 592-byte ROM image has SHA-256
`a65a76f0d109431960ff5bf11d1fdfcb02b795674ac986b85ef3b0a2826ba6e5`.
A real browser build and the browser WASI adapter produce the same image as Node;
Node/browser ELF and BIN parity and independent esptool-js parsing are tested.
No native compiler, SDK runtime, Python or native esptool is required.

The passing run received one boot banner and 113 heartbeats across 64,608 ms,
with a maximum heartbeat gap of 578 ms and no detected exception/reset.
The physical acceptance test checks automatic DTR/RTS ROM entry, compressed flash
programming at offset 0, complete byte-for-byte flash readback, hardware reset,
65 seconds of actual UART execution at 115200 baud, exactly one application boot
banner, alternating GPIO2 LOW/HIGH messages, no unexpected resets/exceptions,
and an identical offline rebuild. Results are written to ignored
`.wicro/hardware/esp8266-acceptance.json` and the corresponding serial log.
The original first erase sector was saved locally before the first write.
GPIO2 writes are exercised by running firmware; visual LED behavior and external
pin voltage were not observed. Browser hardware uploading has not been physically
verified; the verified hardware transport is Node serial.

## Use the verified profile

```sh
node packages/wicro/bin/wicro.js build --project=examples/esp8266/bare-metal-heartbeat
node packages/wicro/bin/wicro.js upload --project=examples/esp8266/bare-metal-heartbeat \
  --port=/dev/ttyUSB0 --mac=ac:0b:fb:dc:d2:43
node packages/wicro/bin/wicro.js monitor --port=/dev/ttyUSB0 --baud=115200
```

`--mac` is optional for ordinary uploads but recommended when selecting hardware.
An explicit `--port` is required. Alternatively use
`--programmer=esp8266-uart --bin=/absolute/path/firmware.bin --port=/dev/ttyUSB0`.
The uploader rejects non-ESP8266 chips, incompatible images, different detected
flash capacity or crystal, and a mismatched requested MAC before flash writes.

With `npm run dev:web`, select the **esp8266/bare-metal-heartbeat** example.
Its `esp8266-bare-metal` board uses the bare-metal framework, ROM image format,
UART programmer and fixed 115200 upload baud. Readback is mandatory. Flash and
serial monitor use the same port coordinator. Automatic reset requires a board
whose USB-UART DTR/RTS lines implement the standard ESP8266 auto-reset circuit.
The implemented browser uploader uses Web Serial and the same flashing logic,
but browser permission/USB driver behavior still needs hardware verification.

On this Linux host, membership in `dialout` provides persistent tty permissions.
Sandbox approval for host device operations is independent of Unix permissions.
No system permission changes are performed by the implementation.

## Reproduce physical acceptance

This command **replaces the boot image on the selected board**. The matching MAC
is required by the opt-in test; normal `npm test` skips hardware writes.

```sh
WICRO_ESP8266_HARDWARE=1 \
WICRO_ESP8266_MAC=ac:0b:fb:dc:d2:43 \
WICRO_ESP8266_PORT=/dev/ttyUSB0 \
npm run test:esp8266-hardware
```

The generic uploader reports that reset was requested; it does not equate a
reset command with confirmed execution. The acceptance test establishes execution
independently by receiving the boot banner and continuing heartbeats.

## Implementation boundaries and fixes

- The example executes from IRAM and stores initialized data in DRAM; BSS is
  cleared by its real startup path. It retains the early ROM clock configuration,
  masks interrupts, feeds the hardware watchdog, drives GPIO2 and writes UART0.
  The early UART clock on this 26 MHz crystal target is 52 MHz; the example sets
  its divisor accordingly. The recipe does not configure or claim an 80 MHz CPU
  clock or expose overclock controls.
- `esp8266-rom` encodes the ROM v1 header, segment addresses, alignment, checksum
  and entry point. Unsupported RAM layouts and flash-mapped SDK images fail
  explicitly. The current profile is DIO/40 MHz flash with 4 MiB capacity; it is
  not automatically applied to arbitrary ESP8266 board variants.
- Xtensa assembly explicitly uses LLVM's integrated assembler so WASI does not
  attempt to spawn an external assembler. The shared engine asks the linker for
  ELF and lets the registered firmware-format handler generate the target image.
- esptool-js 0.7.1 represents absent ESP8266 SPI bit-length registers as zero,
  while its transfer implementation checks for nullish values. The shared
  ESP8266 adapter translates that sentinel, selecting the actual legacy USR1
  bit-length path. Without this correction, flash-ID reads on this board returned
  zero. The fix was verified against the actual JEDEC ID and capacity.
- Node's serial transport exposes the baud-rate property used by esptool-js crystal
  detection. DTR/RTS updates retain the other line's state, since SerialPort.set
  supplies defaults for omitted flags. Application reset explicitly asserts and
  releases RTS with DTR deasserted. This prevents accidentally sampling GPIO0 low
  and remaining in the serial bootloader.

References: [Espressif ROM firmware image format](https://docs.espressif.com/projects/esptool/en/latest/esp8266/advanced-topics/firmware-image-format.html),
[Espressif ESP8266 registers](https://github.com/espressif/ESP8266_NONOS_SDK/blob/master/include/eagle_soc.h),
[esptool-js](https://github.com/espressif/esptool-js).
