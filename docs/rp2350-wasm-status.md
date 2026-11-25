# Generic RP2350 WASM hardware support

The connected generic RP2350 now has two working bare-metal profiles: `rp2350` for Arm Cortex-M33 and `rp2350-riscv` for Hazard3 RISC-V. Both use the shared LLVM/LLD WASM build engine across Web, Node/CLI and VS Code. No native compiler, Pico SDK installation or Python is needed for these projects. The compiler downloads on demand and persists in the normal Wicro cache.

## Verified scope

ROM device `2e8a:000f`, serial `CF6088FCDF03D1A3`, was physically tested on 25 November 2026. Its ROM chip information reports device/wafer words corresponding to that serial. The original first flash sector was saved locally under ignored `.wicro/rp2350` before programming.

| Profile | Firmware | Physical execution |
|---|---|---|
| `rp2350` | Cortex-M33 secure Arm PICOBIN; 1,840-byte BIN | Full PICOBOOT readback, 130 nonce challenges over 65 seconds, sequence 1–130 and heartbeat progression; runtime-to-ROM entry and subsequent uploads |
| `rp2350-riscv` | Hazard3 RV32IMAC with Zicsr/Zifencei; 1,656-byte BIN | Full PICOBOOT readback, 130 nonce challenges over 65 seconds, sequence 1–130 and heartbeat progression; its own ROM-entry command, another readback-verified upload and fresh sequence 1 |

Firmware SHA-256 identities:

- Arm: `5c2b3e38ff3b29d0edd9cd7ce7ed5061b54cb058f991e258b30438e8bb45f825`
- RISC-V: `68f3be793edd4d89c6ac490223a1cc9991a95ab37a08f4e81bee371d392fec52`

Both profiles use a 12 MHz crystal and run system/USB clocks at 48 MHz. The linker and uploader deliberately bound flash to the first 2 MiB and SRAM to 520 KiB. The ROM reports a CS0 flash configuration of 16 MiB; this is not an independent measurement of the board's actual flash capacity, and does not expand the profile. No LED pin is assumed for an unidentified generic board.

Real Chromium, CLI and VS Code host tests compare ELF, BIN and UF2 bytes and exercise offline cached builds. USB challenge responses identify which architecture is executing. Browser WebUSB flashing is implemented using the shared PICOBOOT driver, but physical browser upload and mass-storage UF2 copying have not been verified on this board. Physical evidence uses Node/CLI USB transfers.

Arduino, complete Pico SDK integration, TinyUSB/CDC, multicore, TrustZone application separation, signed/secure-boot images, OTP modification, external peripherals, LED behavior and higher clock rates remain outside this verification. The diagnostic runtime is a vendor USB interface, not a tty serial console.

## Use

```sh
node packages/wicro/bin/wicro.js build --project=examples/rp2350/usb-heartbeat
node packages/wicro/bin/wicro.js upload --project=examples/rp2350/usb-heartbeat --serial=CF6088FCDF03D1A3

node packages/wicro/bin/wicro.js build --project=examples/rp2350-riscv/usb-heartbeat
node packages/wicro/bin/wicro.js upload --project=examples/rp2350-riscv/usb-heartbeat --serial=CF6088FCDF03D1A3
```

Use your own ROM serial. First provisioning requires BOOTSEL; the installed example can subsequently request ROM entry over USB. Runtime discovery permits only one matching Wicro diagnostic device; with several boards, use hardware BOOTSEL to select the intended target. The ROM serial is checked before writing. Switching architectures uses RP2350 REBOOT2 with an explicit Arm/RISC-V selection.

In `npm run dev:web`, select `rp2350/usb-heartbeat` or `rp2350-riscv/usb-heartbeat`. Build produces downloadable BIN, ELF and architecture-specific UF2. Flash prompts for RP2350 ROM BOOTSEL. The configuration's **Enter ROM through USB** action prompts separately for the running diagnostic interface; wait for ROM enumeration and click Flash. HTTPS/localhost, WebUSB and OS USB access are required.

The prototype runtime uses the development VID/PID `0000:0001` and serial `WICRO-RP2350`, following the existing low-level diagnostic example. These are development identities, not an allocated production USB identity. USB permissions must cover ROM and runtime re-enumeration; tty/dialout access alone does not grant raw USB access.

## Image and transport validation

RP2350 does not use RP2040 boot2 CRC images. The image validator accepts the explicit unsigned single-block PICOBIN layouts produced by these examples and checks chip/CPU/security type, block terminators, stack and entry bounds. ELF machine type must match the boot metadata. UF2 uses family `e48bff59` for Arm secure and `e48bff5a` for RISC-V. Mixed families, duplicate blocks, inconsistent addresses and architecture mismatches are rejected. Other valid upstream PICOBIN layouts require additional parser support before acceptance.

The explicit flat-flash ELF conversion uses physical load addresses for both instruction architectures. It avoids the legacy ELF helper's ESP32-specific RISC-V auto-selection. Existing ESP32 behavior is preserved. PICOBOOT validates the image before ROM entry, erases only occupied 4 KiB sectors, programs padded 256-byte pages, compares every image byte and requests the architecture-specific reboot. Bytes after the image within its final erased sector are replaced with `0xff`. Upload readback and subsequent runtime execution are reported separately.

## Reproduce

`tests/rp2350.test.js` runs real cross-host builds, checks browser configuration and UF2 output, offline reuse, and malformed image rejection. Hardware tests are explicitly opt-in and write the selected board:

```sh
WICRO_RP2350_HARDWARE=1 WICRO_RP2350_SERIAL=CF6088FCDF03D1A3 \
node --test tests/rp2350-hardware.test.js
```

This checks both architectures, CLI uploads, 65 seconds of real USB challenges per architecture, another upload through each runtime's ROM hook, and identical offline rebuilds. Reports stay under ignored `.wicro/rp2350`; no downloaded SDKs, compiler binaries, firmware or backups are committed.

Protocol and register references are pinned to Raspberry Pi [Pico SDK 2.1.0](https://github.com/raspberrypi/pico-sdk/tree/2.1.0), including [PICOBIN definitions](https://github.com/raspberrypi/pico-sdk/blob/2.1.0/src/common/boot_picobin_headers/include/boot/picobin.h), [PICOBOOT](https://github.com/raspberrypi/pico-sdk/blob/2.1.0/src/common/boot_picoboot_headers/include/boot/picoboot.h), [RP2350 registers](https://github.com/raspberrypi/pico-sdk/tree/2.1.0/src/rp2350/hardware_regs/include/hardware/regs) and [ROM lookup](https://github.com/raspberrypi/pico-sdk/blob/2.1.0/src/rp2_common/pico_bootrom/include/pico/bootrom.h).
