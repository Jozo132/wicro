# Arduino UNO original blink

Bare-metal AVR reference firmware for the original ATmega328P UNO.

```sh
make
make check
make clean
```

Outputs:

- `build/blink.elf`: ELF32 AVR executable
- `build/blink.hex`: Intel HEX flash image

Configuration:

- ATmega328P at 16 MHz
- Arduino LED: PB5 (D13), active-high
