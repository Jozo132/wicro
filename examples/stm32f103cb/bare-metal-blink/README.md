# STM32F103CB bare-metal blink

Native Cortex-M3 reference firmware for a Blue Pill-compatible STM32F103CB board.

```sh
make
make check
make clean
```

Configuration:

- Cortex-M3 Thumb
- Flash origin: `0x08000000`
- SRAM origin: `0x20000000`
- 128 KB flash / 20 KB SRAM
- Active-low onboard LED: PC13
