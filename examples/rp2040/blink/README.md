# RP2040 blink

Pico SDK blink firmware for RP2040 boards.

```sh
cmake -S . -B build -DPICO_BOARD=pico
cmake --build build
```

Configuration:

- Cortex-M0+ dual core
- `PICO_DEFAULT_LED_PIN` (GPIO25 on Pico)
- Active-high LED
