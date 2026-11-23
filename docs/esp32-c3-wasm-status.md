# ESP32-C3 Wicro WASM status

## Status

**Verified end-to-end.** Wicro compiles and links genuine Arduino-ESP32 (`setup()`/`loop()`) firmware for ESP32-C3 entirely through `llvm.wasm` (`clang` + `ld.lld` under WASI, zero native toolchain fallback, zero weak startup stubs), generates an Espressif-compliant application BIN with byte-for-byte esptool parity, flashes it automatically over USB-JTAG with byte-for-byte readback, and runs stably on the physical ESP32-C3 SuperMini for 65+ seconds with `WICRO_SERIAL_READY`, `LED ON`/`LED OFF` serial output, GPIO8 blinking, and zero resets.

## Boot-loop root cause (resolved)

The earlier boot loop (`rst:0x3 (RTC_SW_SYS_RST)`, `boot:0xd (SPI_FAST_FLASH_BOOT)`, `entry 0x403cc710` repeating before ESP-IDF startup) was localized to second-stage bootloader application image loading:

1. **Missing `esp_app_desc_t` and incomplete startup closure**: The prior ELF lacked `.flash.appdesc` (magic `0xabcd5432`) and used weak stubs instead of genuine ESP-IDF startup/runtime libraries.
2. **Broken `elfToEsp32Bin()` segment encoding**: The previous converter iterated ELF `PT_LOAD` program headers (which included `NOLOAD` dummy gaps like `.flash_rodata_dummy` and `.dram0.dummy`), emitted segments at misaligned flash offsets (violating the ESP32-C3 MMU 64 KB page constraint `(file_offset & 0xffff) == (vaddr & 0xffff)`), and did not populate `esp_app_desc_t.app_elf_sha256` or `max_chip_rev_full`.

Replacing `elfToEsp32Bin()` with section-based merging, 64 KB MMU alignment via RAM segment splitting/zero-padding, `app_elf_sha256` population, and `max_chip_rev_full = 0xffff` achieved **byte-for-byte parity** with official `esptool` on `reference-firmware.elf` (`270,640` bytes, 0 differing bytes).

## WASI LLD segmentation fault root cause (resolved)

Running the reproducer under `gdb` isolated the SIGSEGV (`exit 139`) to Node.js v22 `node:wasi`:

```text
v8::internal::InnerPointerToCodeCache::GetCacheEntry
 <- v8::internal::Heap::MarkCompact
 <- v8::internal::Heap::ReportExternalMemoryPressure
 <- uvwasi_path_open
 <- node::wasi::WASI::WasiFunction<PathOpen>::FastCallback
```

When `ld.lld` opened many archives via `uvwasi_path_open`, V8's `FastCallback` trampoline did not support triggering a full Mark-Compact GC via `AdjustAmountOfExternalAllocatedMemory`, crashing V8 stack walking. Wrapping `wasi.wasiImport` entries in plain JavaScript functions (`(...args) => fn(...args)`) bypasses the unsafe V8 FastCallback path and completely eliminates the SIGSEGV.

Four additional link-time issues were resolved without weak stubs or native fallback:

1. **File-backed `/sdk` WASI preopens**: SDK archives stay on disk and are passed as `/sdk/lib/*.a` paths instead of copying into JS memory.
2. **ABI-matched runtime archives**: Staged `libspi_flash.a` (from `dio_qspi`) and GCC 8.4.0 `rv32imc/ilp32/no-rtti` `libc.a`, `libm.a`, `libnosys.a`, `libstdc++.a`, `libsupc++.a`, `libgcc.a` matching Arduino-ESP32 2.0.17.
3. **LLD compatibility with ESP-IDF scripts and `vectors.S.obj`**:
   - Extracted `vectors.S.obj` from `libriscv.a` in pure JS (`extractArchiveMember`) and set `SHF_ALLOC | SHF_EXECINSTR` (`0x6`) on `.exception_vectors.text` (`patchElfSectionFlags`) so LLD treats it as an allocatable executable section.
   - Adapted `memory.ld` / `sections.ld` (`prepareEsp32C3LinkerScripts`) for LLD's single-pass evaluation: moved `.iram0.text_end`/`.iram0.data`/`.iram0.bss` before `.dram0.dummy`, moved the `_flash_rodata_dummy_start` assertion after `SECTIONS`, discarded stale `.eh_frame`/`.eh_frame_hdr`, and passed `-z norelro`.
4. **USB Serial/JTAG (`HWCDC`)**: Compiled `core/HWCDC.cpp` and `core/HardwareSerial.cpp` with `-DARDUINO_USB_MODE=1 -DARDUINO_USB_CDC_ON_BOOT=1` via WASM `clang` so `Serial` routes to the ESP32-C3 USB Serial/JTAG peripheral.

## USB-JTAG CDC reset fix (resolved)

- Updated `ESP32_C3_USB_JTAG_RESET_STEPS` to the exact Espressif `USBJTAGSerialReset` sequence (`(0,0)->100ms->(1,0)->100ms->(0,1)->100ms->(0,0)->50ms`) and closed the serial port before detaching the kernel driver.
- Added `ESP32_C3_USB_JTAG_HARD_RESET_STEPS` (`(0,0)->20ms->(0,1)->0ms->(0,0)`) after flashing so the board exits download mode cleanly and boots the application while `monitor()` opens `/dev/ttyACM0` within ~4 ms to capture the ROM banner and `WICRO_SERIAL_READY`.

## Artifact comparison

- Wicro WASM-built ELF: `12,779,432` bytes (unstripped, entry `0x403834f8` `call_start_cpu0`)
- Wicro WASM-built BIN: `246,880` bytes (7 segments, `esp_app_desc_t` valid, 64 KB MMU aligned, checksum & SHA-256 verified)
- Native PlatformIO reference ELF: `6,041,556` bytes (entry `0x40381f4c`)
- Native PlatformIO reference BIN: `270,640` bytes (Wicro `elfToEsp32Bin(reference-firmware.elf)` matches byte-for-byte)

## Hardware acceptance

`WICRO_ESP32_HARDWARE=1 node --test tests/esp32-c3-hardware.test.js` passes end-to-end:

- Clean WASM compile + WASM link + ELF/BIN validation
- Automatic USB-JTAG ROM entry, app-only flash at `0x10000` (`246,880` bytes in `~0.96 s`), byte-for-byte readback, and clean hard reset
- Captures `WICRO_SERIAL_READY` and >=50 `LED ON` / `LED OFF` pairs over 65 seconds with zero unexpected resets
- Second offline cached build succeeds (`cache: hit`)

## Ordinary validation

Strict JSDoc checks (`npm run check:types`), workspace tests (`npm test`), browser build (`npm run build:web`), and npm dry-run packaging (`npm run pack:check`) all pass. Hardware tests remain gated behind `WICRO_ESP32_HARDWARE=1`.
