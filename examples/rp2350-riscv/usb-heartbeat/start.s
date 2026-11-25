.section .text.start,"ax"
.globl _start
_start:
  csrci mstatus, 8
  li sp, 0x20082000
  call Reset_Handler
1: j 1b
