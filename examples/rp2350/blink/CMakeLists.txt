cmake_minimum_required(VERSION 3.13)

include(pico_sdk_import.cmake)
project(wicro_rp2350_blink C CXX ASM)

pico_sdk_init()

add_executable(wicro_rp2350_blink main.c)
target_link_libraries(wicro_rp2350_blink pico_stdlib)
pico_add_extra_outputs(wicro_rp2350_blink)
