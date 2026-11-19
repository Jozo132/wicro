# RP2350 blink

Pico SDK blink firmware for RP2350 boards.

```sh
cmake -S . -B build -DPICO_BOARD=pico2
cmake --build build
```

Configuration:

- Cortex-M33 with Pico SDK
- `PICO_DEFAULT_LED_PIN` (GPIO25 on Pico 2)
- Active-high LED
