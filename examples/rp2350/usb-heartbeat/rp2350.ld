ENTRY(Reset_Handler)
MEMORY {
 flash (rx) : ORIGIN = 0x10000000, LENGTH = 2M
 ram (rwx) : ORIGIN = 0x20000000, LENGTH = 520K
}
SECTIONS {
 .vectors : { KEEP(*(.vectors)) } >flash
 .image_def : { KEEP(*(.image_def)) } >flash
 .text : { *(.text .text.*) *(.rodata .rodata.*) . = ALIGN(4); } >flash
 .ARM.exidx : { *(.ARM.exidx*) } >flash
 .data : { _sdata = .; *(.data .data.*) . = ALIGN(4); _edata = .; } >ram AT>flash
 _sidata = LOADADDR(.data);
 .bss (NOLOAD) : { _sbss = .; *(.bss .bss.*) *(COMMON) . = ALIGN(4); _ebss = .; } >ram
 /DISCARD/ : { *(.comment) *(.note*) }
}
