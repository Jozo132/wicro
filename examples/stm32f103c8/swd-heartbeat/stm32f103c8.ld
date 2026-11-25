ENTRY(Reset_Handler)
MEMORY { FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 64K
 SRAM (rwx) : ORIGIN = 0x20000000, LENGTH = 20K }
_estack = ORIGIN(SRAM) + LENGTH(SRAM);
SECTIONS {
 .isr_vector : { KEEP(*(.isr_vector)) } > FLASH
 .text : { *(.text*) *(.rodata*) . = ALIGN(4); } > FLASH
 .ARM.exidx : { *(.ARM.exidx*) } > FLASH
 .mailbox (NOLOAD) : { KEEP(*(.mailbox)) } > SRAM
 .data : { _sdata = .; *(.data*) . = ALIGN(4); _edata = .; } > SRAM AT> FLASH
 _sidata = LOADADDR(.data);
 .bss (NOLOAD) : { _sbss = .; *(.bss*) *(COMMON) . = ALIGN(4); _ebss = .; } > SRAM
 ASSERT(SIZEOF(.mailbox) == 32, "Diagnostic mailbox must occupy first 32 SRAM bytes")
 ASSERT(_ebss <= _estack - 1024, "Reserve at least 1 KiB stack")
 /DISCARD/ : { *(.comment) *(.note*) }
}
