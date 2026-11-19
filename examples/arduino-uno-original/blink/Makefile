CC = avr-gcc
OBJCOPY = avr-objcopy
MCU = atmega328p
CFLAGS = -mmcu=$(MCU) -Os -DF_CPU=16000000UL -Wall -Wextra

build/blink.elf: main.c
	mkdir -p build
	$(CC) $(CFLAGS) main.c -o $@

build/blink.hex: build/blink.elf
	$(OBJCOPY) -O ihex -R .eeprom $< $@

check: build/blink.elf
	avr-size $<

all: build/blink.hex

clean:
	rm -rf build
