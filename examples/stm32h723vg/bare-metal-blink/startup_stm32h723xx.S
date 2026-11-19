 .syntax unified
.cpu cortex-m7
.thumb

.global Reset_Handler
.global vector_table

.section .isr_vector,"a",%progbits
vector_table:
    .word 0x24020000
    .word Reset_Handler
    .word Default_Handler
    .word Default_Handler
    .word Default_Handler
    .word Default_Handler
    .word Default_Handler
    .word 0
    .word 0
    .word 0
    .word 0
    .word Default_Handler
    .word Default_Handler
    .word 0
    .word Default_Handler
    .word Default_Handler

.section .text.Reset_Handler
.type Reset_Handler,%function
Reset_Handler:
    ldr r0, =_estack
    mov sp, r0
    bl main

1:
    b 1b

.section .text.Default_Handler,"ax",%progbits
.type Default_Handler,%function
Default_Handler:
    b Default_Handler
