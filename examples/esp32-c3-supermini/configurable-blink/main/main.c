#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"

#ifndef WICRO_BLINK_MS
#define WICRO_BLINK_MS 250
#endif

#define LED_GPIO GPIO_NUM_8

void app_main(void)
{
    gpio_reset_pin(LED_GPIO);
    gpio_set_direction(LED_GPIO, GPIO_MODE_OUTPUT);
    bool on = false;

    while (true) {
        on = !on;
        gpio_set_level(LED_GPIO, on ? 0 : 1);
        printf("WICRO_FREQ blink=%dms led=%s\n", WICRO_BLINK_MS, on ? "ON" : "OFF");
        vTaskDelay(pdMS_TO_TICKS(WICRO_BLINK_MS));
    }
}
