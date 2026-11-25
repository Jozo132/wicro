# RP2040-Zero WASM hardware status

The Waveshare RP2040-Zero has a working bare-metal firmware recipe in the shared
Node/browser engine. LLVM and LLD run entirely in WASM. The recipe produces a
bootable flash BIN with the ROM-required boot2 CRC and an RP2040-family UF2.
It uses project sources and the downloaded compiler; no native toolchain or Pico
SDK installation is required. Arduino, TinyUSB, CDC serial and full Pico SDK
integration remain separate work.

## Physical evidence

On 25 November 2026, board ROM serial `E0C9125B0D9B` passed:

- Public CLI upload through ROM PICOBOOT, with complete 2,024-byte image readback.
- 130 real USB nonce challenges over 65 seconds, increasing sequence and hardware
  timer values, and 65 firmware heartbeat increments without an unexpected reset.
- Firmware vendor request to return to ROM, a second upload/readback, and a fresh
  runtime response with sequence 1.
- A byte-identical offline rebuild. Firmware SHA-256:
  `cf15db76f429571a12a2ec16c1bd82c04a2f14ae7aa1edae3bdf40e5907e300c`.

The original first flash sector and acceptance report remain local under ignored
`.wicro/rp2040`. Initial USB enumeration failed with a 12 MHz system clock;
the working recipe runs both system and USB clocks at 48 MHz from the USB PLL.
The board has 2 MiB flash, 264 KiB SRAM and a 12 MHz crystal. Its WS2812 on GPIO16
is **not implemented or visually verified**. This verification does not establish
other RP2040 boards, RP2350, general peripherals, multicore or overclock support.

Automated Node WASI/browser WASI tests compare ELF, BIN and UF2 bytes. Real Chromium
also builds the example and checks the configuration controls. Browser hardware
upload and copying UF2 to the ROM mass-storage drive have not been physically
verified; the verified physical route is Node/CLI PICOBOOT using BIN.

## Use

```sh
node packages/wicro/bin/wicro.js build --project=examples/rp2040-zero/usb-heartbeat
# For first provisioning, hold BOOT and tap RESET, then release BOOT.
node packages/wicro/bin/wicro.js upload --project=examples/rp2040-zero/usb-heartbeat \
  --serial=E0C9125B0D9B
```

Substitute your board's ROM serial. Later uploads can request ROM entry from this
example's running firmware. Runtime discovery currently allows one matching
diagnostic device; use hardware BOOTSEL to select the intended board when multiple
devices are connected. The ROM serial is checked before programming. A rejected
serial selection does not authorize programming a different ROM device.

In `npm run dev:web`, choose **rp2040-zero/usb-heartbeat**, build, then Flash and
select the BOOTSEL device. For subsequent uploads, use **Enter ROM through USB**,
wait for enumeration, then Flash. The two permission gestures are deliberate:
runtime and ROM are separate WebUSB devices. A secure context, WebUSB support and
OS access to each USB device are required.

The example is a vendor USB diagnostic device, with bulk nonce responses and a
vendor ROM-entry command, rather than a tty serial monitor. It uses the Pico
low-level example's development IDs `0000:0001` and a fixed diagnostic serial
`WICRO-RP2040-ZERO`; these are prototype identities, not an allocated production
USB identity. ROM mode is `2e8a:0003` with the board's own serial.

PICOBOOT discovers its vendor interface and endpoints, checks command status,
erases only occupied 4 KiB sectors, writes 256-byte pages, and verifies every
image byte before requesting reboot. The partial final page is padded with 0xff.
Image checks enforce the explicit 2 MiB profile, boot2 CRC, SRAM stack bounds and
Thumb reset vector. Sector erase replaces bytes past the image within its final
sector. Successful upload reports readback and a reboot request; runtime execution
is established separately by the hardware test.

## Reproduce hardware acceptance

```sh
WICRO_RP2040_HARDWARE=1 WICRO_RP2040_SERIAL=E0C9125B0D9B \
node --test tests/rp2040-hardware.test.js
```

This opt-in test writes the selected board. Normal tests skip hardware writes.
It exercises CLI dispatch, sustained USB communication, runtime-to-ROM entry,
second upload and cached offline compilation.

The generic serial-read boot2 and revision-1 enumeration workaround follow
Raspberry Pi's BSD-3-Clause code; the retained license is in
`examples/rp2040-zero/usb-heartbeat/LICENSE.boot2`. The connected chip reports
revision 2, so the revision-1 workaround was not physically exercised. On revision
1 it temporarily uses GPIO15 and restores its pad/control state.

References: [Waveshare board documentation](https://www.waveshare.com/wiki/RP2040-Zero),
[PICOBOOT protocol](https://github.com/raspberrypi/pico-sdk/blob/2.1.0/src/common/boot_picoboot_headers/include/boot/picoboot.h),
[Pico low-level USB example](https://github.com/raspberrypi/pico-examples/tree/master/usb/device/dev_lowlevel),
[RP2040 boot ROM](https://github.com/raspberrypi/pico-bootrom-rp2040/blob/master/bootrom/bootrom_main.c).
