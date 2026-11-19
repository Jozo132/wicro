# STM32H723VG bare-metal blink

Native Cortex-M7 reference firmware for an STM32H723VG board.

```sh
make
make check
make clean
```

Configuration:

- Cortex-M7 Thumb with hard-float FPv5-D16 ABI
- Flash origin: `0x08000000`
- AXI SRAM origin: `0x24000000`
- 1 MB flash
- Active-low LED example: PE3 (board-dependent)
