# STM32F401RC bare-metal blink

Native Cortex-M4 reference firmware.

```sh
make
make check
```

Outputs:

- `build/blink.elf`: ELF32 ARM executable
- `build/blink.bin`: raw flash image

Configuration:

- Cortex-M4 Thumb with hard-float ABI
- Flash origin: `0x08000000`
- SRAM origin: `0x20000000`
- Inverted red LED: PC13 (active-low)
