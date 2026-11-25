ENTRY(_start)
MEMORY {
  iram (rx) : ORIGIN = 0x40100000, LENGTH = 32K
  dram (rw) : ORIGIN = 0x3ffe8000, LENGTH = 64K
}
SECTIONS {
  .text : ALIGN(4) { *(.literal.entry) KEEP(*(.text.entry)) *(.literal .literal.*) *(.text .text.*) . = ALIGN(4); } >iram
  .data : ALIGN(4) { *(.rodata .rodata.*) *(.data .data.*) . = ALIGN(4); } >dram
  .bss (NOLOAD) : ALIGN(4) { _bss_start = .; *(.bss .bss.*) *(COMMON) . = ALIGN(4); _bss_end = .; } >dram
  /DISCARD/ : { *(.comment) *(.note*) *(.eh_frame*) *(.xtensa.info) }
}
