#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"

#define LED_GPIO GPIO_NUM_8

#define WICRO_WEAK_STUB __attribute__((weak))

WICRO_WEAK_STUB void esp_mspi_pin_init(void) {}
WICRO_WEAK_STUB int spi_flash_init_chip_state(void) { return 0; }
WICRO_WEAK_STUB unsigned char esp_mspi_get_io(unsigned int io) { (void)io; return 0; }
WICRO_WEAK_STUB int esp_flash_app_init(void) { return 0; }
WICRO_WEAK_STUB int esp_ota_get_app_elf_sha256(void *sha, unsigned int size) { (void)sha; (void)size; return 0; }
WICRO_WEAK_STUB int esp_core_dump_to_flash(void) { return 0; }
WICRO_WEAK_STUB int spi_flash_init(void) { return 0; }
WICRO_WEAK_STUB void *g_flash_guard_default_ops = (void *)0;
WICRO_WEAK_STUB char **environ = (char **)0;
WICRO_WEAK_STUB int __errno = 0;
WICRO_WEAK_STUB unsigned int esp_log_timestamp(void) { return 0; }
WICRO_WEAK_STUB void esp_log_write(int level, const char *tag, const char *format, ...) { (void)level; (void)tag; (void)format; }
WICRO_WEAK_STUB char esp_log_default_level = 5;
WICRO_WEAK_STUB int gettimeofday(void *tv, void *tz) { (void)tv; (void)tz; return 0; }
WICRO_WEAK_STUB int esp_vfs_console_register(void) { return 0; }
WICRO_WEAK_STUB int esp_pthread_init(void) { return 0; }
WICRO_WEAK_STUB struct _reent _impure_data;
WICRO_WEAK_STUB struct _reent *_impure_ptr = &_impure_data;
WICRO_WEAK_STUB void _reclaim_reent(struct _reent *reent) { (void)reent; }
WICRO_WEAK_STUB FILE *fopen(const char *name, const char *mode) { (void)name; (void)mode; return (FILE *)0; }
WICRO_WEAK_STUB int printf(const char *format, ...) { (void)format; return 0; }
WICRO_WEAK_STUB int vprintf(const char *format, va_list ap) { (void)format; (void)ap; return 0; }
WICRO_WEAK_STUB int esp_flash_init_default_chip(void) { return 0; }
WICRO_WEAK_STUB int esp_core_dump_init(void) { return 0; }
WICRO_WEAK_STUB void bootloader_flash_update_id(void) {}
WICRO_WEAK_STUB void bootloader_init_mem(void) {}
WICRO_WEAK_STUB int heap_caps_init(void) { return 0; }
WICRO_WEAK_STUB void heap_caps_enable_nonos_stack_heaps(void) {}
WICRO_WEAK_STUB void riscv_global_interrupts_enable(void) {}
WICRO_WEAK_STUB void esp_pm_impl_waiti(void) {}
WICRO_WEAK_STUB int esp_timer_early_init(void) { return 0; }
WICRO_WEAK_STUB void *g_coex_adapter_funcs = (void *)0;
WICRO_WEAK_STUB int esp_coex_adapter_register(void) { return 0; }
WICRO_WEAK_STUB int coex_pre_init(void) { return 0; }
WICRO_WEAK_STUB void _Unwind_SetEnableExceptionFdeSorting(int enable) { (void)enable; }
WICRO_WEAK_STUB void _cleanup_r(void *reent) { (void)reent; }
WICRO_WEAK_STUB void *xRingbufferReceive(void *ringbuf, unsigned int *size) { (void)ringbuf; if (size) *size = 0; return (void *)0; }
WICRO_WEAK_STUB void vRingbufferReturnItem(void *ringbuf, void *item) { (void)ringbuf; (void)item; }
WICRO_WEAK_STUB int xRingbufferSend(void *ringbuf, const void *data, unsigned int size, unsigned int wait) { (void)ringbuf; (void)data; (void)size; (void)wait; return 0; }

WICRO_WEAK_STUB long _sbrk(intptr_t incr) { (void)incr; return -1; }
WICRO_WEAK_STUB int _read(int fd, void *buf, unsigned int count) { (void)fd; (void)buf; (void)count; return -1; }
WICRO_WEAK_STUB int _write(int fd, const void *buf, unsigned int count) { (void)fd; (void)buf; (void)count; return -1; }
WICRO_WEAK_STUB int _close(int fd) { (void)fd; return -1; }
WICRO_WEAK_STUB long _lseek(int fd, long offset, int whence) { (void)fd; (void)offset; (void)whence; return -1; }
WICRO_WEAK_STUB int _fstat(int fd, void *st) { (void)fd; (void)st; return -1; }
WICRO_WEAK_STUB int _getpid(void) { return 1; }
WICRO_WEAK_STUB int _kill(int pid, int sig) { (void)pid; (void)sig; return -1; }
WICRO_WEAK_STUB long _gettimeofday(void *tv, void *tz) { (void)tv; (void)tz; return -1; }

void app_main(void)
{
    gpio_reset_pin(LED_GPIO);
    gpio_set_direction(LED_GPIO, GPIO_MODE_OUTPUT);

    bool led_on = false;
    while (true) {
        led_on = !led_on;
        gpio_set_level(LED_GPIO, led_on ? 0 : 1);
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}
