#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define LED_GPIO GPIO_NUM_2

void app_main(void)
{
    gpio_reset_pin(LED_GPIO);
    gpio_set_direction(LED_GPIO, GPIO_MODE_OUTPUT);

    bool led_on = false;
    for (;;) {
        led_on = !led_on;
        gpio_set_level(LED_GPIO, led_on ? 1 : 0);
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}
