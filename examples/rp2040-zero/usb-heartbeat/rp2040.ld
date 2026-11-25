ENTRY(Reset_Handler)
MEMORY {
 flash (rx) : ORIGIN = 0x10000000, LENGTH = 2M
 ram (rwx) : ORIGIN = 0x20000000, LENGTH = 264K
}
SECTIONS {
 .boot2 : { KEEP(*(.boot2)) . = ORIGIN(flash) + 252; LONG(0); } >flash
 .vectors : { KEEP(*(.vectors)) } >flash
 .text : { *(.text .text.*) *(.rodata .rodata.*) . = ALIGN(4); } >flash
 .ARM.exidx : { *(.ARM.exidx*) } >flash
 .data : { _sdata = .; *(.data .data.*) . = ALIGN(4); _edata = .; } >ram AT>flash
 _sidata = LOADADDR(.data);
 .bss (NOLOAD) : { _sbss = .; *(.bss .bss.*) *(COMMON) . = ALIGN(4); _ebss = .; } >ram
 /DISCARD/ : { *(.comment) *(.note*) }
}
