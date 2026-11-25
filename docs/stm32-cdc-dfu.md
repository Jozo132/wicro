# STM32F401RC CDC-DFU

The F401RC is the first physically verified CDC-DFU target. The shared USB DFU
engine runs through Node's `usb` WebUSB adapter or browser WebUSB; compilation
and linking use LLVM/LLD WASM. No native compiler or PlatformIO subprocess is
used by this implementation. F401CC was excluded from this work.

## Physical verification

On 25 November 2026 (Europe/Ljubljana), the F401RC with USB serial
`206635AE484E` passed:

1. Manual BOOT0/reset entry into STM32 ROM DFU (`0483:df11`).
2. Page erase and download at `0x08000000`, with byte-for-byte USB readback of
   all 27,672 firmware bytes.
3. Return of the same USB serial as runtime CDC (`0483:5740`).
4. The published CDC-DFU DTR sequence and `DFU!` write over direct USB CDC,
   followed by actual ROM DFU enumeration.
5. A second full download/readback and return to CDC.
6. Reception of the executing application's `WICRO_F401RC_CDC_DFU_READY`
   heartbeat through `/dev/ttyACM0`.

The image SHA-256 was
`ff45b1619d3bb1eba2061eb8fe17f57c1cf060b97740ed7a8eb0a9147aea203e`.
Local reports and firmware remain ignored under `.wicro/hardware` and
`.wicro/stm32f401rc-cdc-dfu`; no vendor archive or binary is committed.
The program toggles PC13, but visual LED operation was not observed by these
checks. Browser USB permission/transfer operation has not been physically tested;
Chromium tests cover the visual configuration and JSON synchronization.

The bootloader disconnected during manifestation with a USB control-transfer
hardware/protocol error. Node accepted the reboot only after the matching serial
returned as CDC. A completed transfer without that enumeration is an error when
application return is requested. Readback and reboot confirmation are separate
results. Other ARM targets and the original package's H7 path remain physically
unverified.

## CLI and first provisioning

```sh
node packages/wicro/bin/wicro.js upload --programmer=cdc-dfu \
  --board=stm32f401rc --bin=/absolute/path/firmware.bin --serial=206635AE484E
```

The image must contain a valid Cortex-M vector table. Flash is bounded to
256 KiB at `0x08000000`; SRAM is 64 KiB at `0x20000000`. The adapter selects
interface 0, alternate 0 (internal flash), reads the advertised geometry and
transfer size, erases only intersecting pages, and verifies every byte before
requesting application entry. It never issues mass erase or read-unprotect.
A page erase that crosses the configured application boundary is rejected.
These are whole application uploads: bytes elsewhere within erased pages are
not preserved.

For a first image, put the board into ROM DFU with BOOT0/reset and add
`--manual-dfu`. The original application on the test board did not respond to
the CDC trigger. Repeated automatic entry requires firmware containing the real
CDC-DFU hook and a matching USB CDC implementation. Application-return checking
expects CDC firmware; `--stay-in-dfu` writes and verifies without starting an
application, including when installing a non-CDC image. Keep BOOT0 in its normal
application-boot state after provisioning for normal subsequent resets.

An explicit serial is recommended; ambiguous devices are rejected. After a CDC
trigger, Node follows the selected runtime USB serial into ROM DFU. The default
trigger uses direct USB control/bulk transfers because this host's tty driver
rejects DTR modem-control operations. The Node API also offers a serial transport.

Linux needs write access to both runtime and ROM DFU devices. Temporary
`setfacl` grants apply to a single `/dev/bus/usb` node and disappear on
re-enumeration. A locally administered udev rule matching the board's serial and
both USB identities can provide persistent access. Wicro does not install system
rules or change permissions automatically.

## Browser workflow

In Platform setup select F401RC and **STM32 CDC trigger / USB DfuSe**.
WebUSB enables Flash; Web Serial is additionally required for **Enter DFU
through CDC**. Upload baud is hidden because DFU uses USB control transfers.
Flash readback is mandatory; serial monitor reconnection is manual.

For first provisioning use BOOT0/reset. For bridge-enabled firmware, click
**Enter DFU through CDC**, select its runtime serial port, wait for enumeration,
then click **Flash** and select STM32 BOOTLOADER. These are separate user gestures
because the browser grants permissions separately to CDC and DFU identities.
A trigger being sent is not reported as a confirmed transition. Browser reboot
status remains unconfirmed unless independently observed; byte readback is the
upload verification. Chromium, HTTPS/localhost and suitable OS USB permissions
are required.

The existing general F401RC build preset remains a bare-metal recipe. Selecting
Arduino or adding the library does not yet install a complete STM32duino SDK
recipe into that preset. A bare-metal image replaces the bridge if it omits the
USB runtime; later entry then requires BOOT0/reset again.

## Real firmware development fixture

```sh
node scripts/build-stm32f401rc-cdc-dfu.js
node scripts/flash-stm32f401rc-cdc-dfu.js \
  --bin=.wicro/stm32f401rc-cdc-dfu/firmware.bin --serial=206635AE484E \
  --manual-dfu --report=.wicro/hardware/first-flash.json
```

This development fixture consumes genuine, already cached STM32duino 3.0.0
(PlatformIO framework package `4.30000.0`), CMSIS, and ARM newlib/libstdc++ 12.3.1
headers/static libraries. Their default locations are under
`~/.platformio/packages`; `--framework=`, `--cmsis=` and `--sysroot=` override
them. `--sysroot` names the containing ARM toolchain package directory. This
script does not execute its native compiler. It is a development fixture,
not an on-demand production STM32 Arduino SDK installer.

The script downloads the checksum-pinned `jozo132/cdc-dfu` 1.1.2 source archive
on demand and reuses it locally. It compiles the genuine Arduino USB/HAL/core
sources, the generic F401RC variant and upstream bridge source with WASM,
preserves the constructor and `.noinit` reset flag, and links genuine ARM runtime
libraries with WASM LLD. Clang's resource headers and LLVM WASM must already be
cached by the repository toolchain setup. `GCC_VERSION=120301` is the framework's
header compatibility macro; the actual compiler is LLVM WASM.

The shared ARM ELF-to-BIN converter uses PT_LOAD physical addresses so initialized
RAM data is stored at its flash load address rather than creating a huge gap to
its RAM execution address. A regression test covers this distinction.

## PlatformIO hook translation and extension

The exact PlatformIO `jozo132/cdc-dfu` 1.1.2 archive, SHA-256
`64911fd4004b4fc8e311fb55cfc06e0d7f5fd2f8fc215c1d22480d92e13e3afe`,
has an explicit shared library recipe. It force-links source objects and adds
`DTR_TOGGLING_SEQ` globally, including to framework USB units. Python is not run.
The build fails unless the selected Arduino recipe supplies STM32F4/H7 USB CDC
defines, avoiding the upstream source's empty compilation guard. Full SDK setup
is still required. Other hook-dependent packages and different releases are
rejected until their effects are ported and tested.

The low-level DFU engine accepts explicit profiles for other devices, but a USB
connector or ARM core alone does not establish compatible bootloader commands,
flash layout or CDC entry behavior. Standard DFU and other MCU paths are not
hardware-verified. New targets need their actual memory/USB profile, firmware
entry mechanism, ABI/startup recipe and physical tests.

References: [CDC-DFU source](https://github.com/Jozo132/cdc-dfu),
[STM32duino](https://github.com/stm32duino/Arduino_Core_STM32),
[ST USB DFU protocol AN3156](https://www.st.com/resource/en/application_note/an3156-usb-dfu-protocol-used-in-the-stm32-bootloader-stmicroelectronics.pdf),
[USB DFU 1.1](https://www.usb.org/sites/default/files/DFU_1.1.pdf).
