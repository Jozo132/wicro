/* Copyright (c) 2019-2021 Raspberry Pi (Trading) Ltd.
 * SPDX-License-Identifier: BSD-3-Clause
 * RP2040 serial-03h XIP bootstrap. Register sequence follows Raspberry Pi Pico SDK
 * boot2_generic_03h.S (BSD-3-Clause); all flash accesses use standard 1-bit reads.
 */
.syntax unified
.cpu cortex-m0plus
.thumb
.section .boot2,"ax",%progbits
.global _stage2_boot
.thumb_func
_stage2_boot:
 push {lr}
 ldr r3, =0x18000000
 movs r1, #0
 str r1, [r3, #8]
 movs r1, #4
 str r1, [r3, #20]
 ldr r1, =0x001f0300
 str r1, [r3, #0]
 ldr r1, =0x03000218
 ldr r0, =0x180000f4
 str r1, [r0]
 movs r1, #0
 str r1, [r3, #4]
 movs r1, #1
 str r1, [r3, #8]
 pop {r0}
 cmp r0, #0
 beq 1f
 bx r0
1:
 ldr r0, =0x10000100
 ldr r1, =0xe000ed08
 str r0, [r1]
 ldmia r0!, {r1, r2}
 msr msp, r1
 bx r2
.ltorg
