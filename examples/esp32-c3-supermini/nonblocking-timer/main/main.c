#include <stdio.h>
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"

#define LED_GPIO GPIO_NUM_8

static void timer_callback(void *arg)
{
    static bool led_on;
    led_on = !led_on;
    gpio_set_level(LED_GPIO, led_on ? 0 : 1);
    printf("WICRO_TIMER led=%s\n", led_on ? "ON" : "OFF");
}

void app_main(void)
{
    gpio_reset_pin(LED_GPIO);
    gpio_set_direction(LED_GPIO, GPIO_MODE_OUTPUT);

    esp_timer_create_args_t args = {
        .callback = timer_callback,
        .name = "wicro-timer"
    };
    esp_timer_handle_t timer;
    esp_timer_create(&args, &timer);
    esp_timer_start_periodic(timer, 500 * 1000);

    int heartbeat = 0;
    while (true) {
        printf("WICRO_IDLE_HEARTBEAT %d\n", ++heartbeat);
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
