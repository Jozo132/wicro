PREFIX ?= arm-none-eabi-
CC := $(PREFIX)gcc
OBJCOPY := $(PREFIX)objcopy
READELF := $(PREFIX)readelf

CPU_FLAGS := -mcpu=cortex-m4 -mthumb -mfloat-abi=hard -mfpu=fpv4-sp-d16
CFLAGS := $(CPU_FLAGS) -ffreestanding -O2 -nostdlib -c
LDFLAGS := $(CPU_FLAGS) -nostdlib -T stm32f401rc.ld

BUILD := build
MAIN := $(BUILD)/main.o
STARTUP := $(BUILD)/startup.o
ELF := $(BUILD)/blink.elf
BIN := $(BUILD)/blink.bin

.PHONY: all clean check

all: $(BIN)

$(BUILD):
	mkdir -p $(BUILD)

$(MAIN): main.c | $(BUILD)
	$(CC) $(CFLAGS) main.c -o $(MAIN)

$(STARTUP): startup_stm32f401xc.S | $(BUILD)
	$(CC) $(CPU_FLAGS) -c startup_stm32f401xc.S -o $(STARTUP)

$(ELF): $(STARTUP) $(MAIN)
	$(CC) $(LDFLAGS) $(STARTUP) $(MAIN) -o $(ELF)

$(BIN): $(ELF)
	$(OBJCOPY) -O binary $(ELF) $(BIN)

check: $(ELF)
	$(READELF) -h $(ELF)

clean:
	rm -rf $(BUILD)
