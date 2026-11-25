.section .literal.entry,"a",@progbits
.align 4
.Lstack: .long 0x3fffff00
.Lmain: .long app_main
.section .text.entry,"ax",@progbits
.align 4
.global _start
.type _start,@function
_start:
  rsil a2, 15
  l32r a1, .Lstack
  l32r a2, .Lmain
  jx a2
