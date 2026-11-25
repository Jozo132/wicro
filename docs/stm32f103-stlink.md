# STM32F103C8 ST-Link hardware support

Wicro builds complete Cortex-M3 firmware through the shared LLVM/LLD WASM engine
and programs the STM32F103C8 directly through a JavaScript ST-Link driver. Node
uses the USB library's WebUSB contract; the browser adapter uses WebUSB itself.
Production programming does not execute OpenOCD, st-flash, Python or a native
compiler. Those tools are not installation requirements for Wicro's driver.

## Target and verified scope

The replacement ST-LINK/V2 reports V2J37S7 and serial
`16180c002c135737334d4e00`. The attached Cortex-M3 reports DBGMCU ID `0x20036410`,
64 KiB flash, 20 KiB SRAM, 1 KiB flash pages, and UID
`066cff353830484257085743`. The UID format is three zero-padded 32-bit words
concatenated in increasing address order, matching `device probe` output.

Use **C8-sized bounds** for this target. Device ID `0x410` is shared by
medium-density STM32F1 variants; it does not prove a complete package marking or
silicon authenticity. The reported 64 KiB capacity does not authorize using an
undocumented upper 64 KiB. The existing `stm32f103cb` fixture remains a separate
128 KiB recipe with no physical CB upload claim.

The `stm32f103c8/swd-heartbeat` example runs from the internal 8 MHz HSI clock.
It initializes the vector table, data/BSS, polled SysTick, an SRAM diagnostic
mailbox and **PB2** for this user's board variant. The PB2 assignment comes from
the user, rather than assuming the common PC13 Blue Pill LED. The firmware
alternates PB2 output states every 500 ms. Output-register verification establishes
register operation; LED polarity and visible LED operation require observation.

Both the target USB cable and ST-Link may stay connected. SWD access goes through
the ST-Link, independent of the target's application USB peripheral. This example
provides SRAM diagnostics, not USB CDC or a tty console. USB application firmware,
Arduino, HAL, USB bootloaders, other STM32 families, overclocking and 128 KiB CB
hardware verification remain separate work. PB2 is also BOOT1; use BOOT0 low for
normal flash boot.

## Use

```sh
node packages/wicro/bin/wicro.js device probe --programmer=stlink \
  --serial=16180c002c135737334d4e00 --json
node packages/wicro/bin/wicro.js build --project=examples/stm32f103c8/swd-heartbeat
node packages/wicro/bin/wicro.js upload --project=examples/stm32f103c8/swd-heartbeat \
  --serial=16180c002c135737334d4e00 --uid=066cff353830484257085743
```

Substitute your probe serial and target UID. Explicit selection is recommended
for uploads and required by the hardware test. Multiple probes without a unique
selection are rejected. V2 probes can encode binary serial bytes as USB UTF-16
code units, including NULs; Wicro reads and normalizes the complete descriptor
instead of truncating the identifier.

In `npm run dev:web`, choose **stm32f103c8/swd-heartbeat**, build, then Flash and
select the ST-Link. The visual configuration uses ST-Link SWD at 100 kHz, mandatory
readback and no serial baud/automatic monitor fields. A supported ST-Link/V2 API
v2 firmware J26 or newer and OS USB access are required. V2/V2.1 product IDs
`3748`, `374b`, `3752` are implemented; only `0483:3748` V2J37S7 has completed the
physical flash/runtime acceptance test. Browser hardware transport is implemented
but has not been physically verified in Chromium. Real Chromium compilation and
configuration controls are automated-tested.

The uploader checks Cortex-M3 identity, medium-density ID, reported capacity,
optional UID, voltage and protection state before flash operations. It rejects
read protection, option-byte errors, write-protected occupied pages and a C8/CB
capacity mismatch. It halts the CPU, unlocks the flash controller, erases only
occupied 1 KiB pages, verifies erased bytes, programs half-words with busy/error
checks, locks the controller, compares every image byte, then resets/runs the CPU.
There is no mass erase, unprotect, option-byte programming or native RAM loader.
An incomplete final half-word is padded with 0xff. Bytes past the image within
its final erase page are replaced. A failed write can leave the CPU halted.

## Debugging in the browser

ST-Link provides the transport needed for a browser-contained embedded debugger.
The current shared API implements memory access, halt, reset/run, flash programming
and live SRAM challenges. Full source debugging also needs core register access,
single-step controls, breakpoint/watchpoint management, DWARF parsing, source
mapping, stack/variable inspection and a debugger UI. These are not currently
claimed as a completed Wicro debugger. A native GDB/OpenOCD server is not inherently
required by this architecture.

WebUSB requires a secure context, a user selection gesture and browser USB
permission. An embedding iframe must allow the `usb` feature. OS setup can require
a suitable driver binding on Windows or device permissions/udev rules on Linux;
granting browser permission does not bypass OS access controls. Once access is
configured, the browser implementation has no runtime requirement to modify host
system files. WASM assets, firmware and debug symbols can be handled in browser
memory/OPFS. Web Serial is optional for a separately implemented UART/CDC console.

## Physical acceptance

On 25 November 2026 the PB2 firmware passed complete 420-byte readback,
127 nonce challenges over a 65,300 ms window, 129 heartbeat increments,
reset recovery and both PB2 output-register states. No sequence reset or halted
CPU was observed during that window. Untouched flash and all 16 option bytes
matched their pre-upload values; the controller was locked afterward. The
offline rebuild was byte-identical. Firmware SHA-256:
`70083f5715f8451a78ac792342dfe025ab317aa931da8f42a3adcb354c67e91b`.

```sh
WICRO_F103_HARDWARE=1 \
WICRO_F103_PROBE=16180c002c135737334d4e00 \
WICRO_F103_UID=066cff353830484257085743 \
node --test tests/stm32f103-hardware.test.js
```

This opt-in command replaces application flash on the explicitly selected target.
Normal tests skip hardware writes. Acceptance covers CLI build/upload/readback,
65 seconds of live nonce challenges with increasing sequence/timer/heartbeat,
running CPU state, both GPIO output-register states, reset recovery, preservation
of untouched flash and option bytes, flash-controller locking, and an identical
offline rebuild. The original complete reported 64 KiB flash backup and raw
acceptance report remain ignored under `.wicro/stm32f103`.

References: [ST RM0008](https://www.st.com/resource/en/reference_manual/cd00171190-stm32f101xx-stm32f102xx-stm32f103xx-stm32f105xx-and-stm32f107xx-advanced-arm-based-32-bit-mcus-stmicroelectronics.pdf),
[STM32F103x8/xB datasheet](https://www.st.com/resource/en/datasheet/stm32f103r8.pdf),
[ST PM0075 flash programming](https://www.st.com.cn/resource/en/programming_manual/pm0075-stm32f10xxx-flash-memory-microcontrollers-stmicroelectronics.pdf),
[ST-Link protocol definitions](https://github.com/stlink-org/stlink/blob/master/inc/stlink_cmd.h),
[WebUSB access](https://developer.chrome.com/docs/capabilities/usb),
[WebUSB OS driver setup](https://developer.chrome.com/docs/capabilities/build-for-webusb).
