#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"

#define LED_GPIO GPIO_NUM_8

void app_main(void)
{
    gpio_reset_pin(LED_GPIO);
    gpio_set_direction(LED_GPIO, GPIO_MODE_OUTPUT);
    gpio_set_level(LED_GPIO, 1);
    setvbuf(stdin, NULL, _IONBF, 0);

    printf("WICRO_COMMANDS READY: LED ON, OFF, TOGGLE, STATUS\n");
    char command[32];
    while (true) {
        if (fgets(command, sizeof(command), stdin) != NULL) {
            if (command[0] == 'O' && command[1] == 'N') {
                gpio_set_level(LED_GPIO, 0);
                printf("WICRO_LED ON\n");
            } else if (command[0] == 'O' && command[1] == 'F' && command[2] == 'F') {
                gpio_set_level(LED_GPIO, 1);
                printf("WICRO_LED OFF\n");
            } else if (command[0] == 'T') {
                int level = gpio_get_level(LED_GPIO);
                gpio_set_level(LED_GPIO, !level);
                printf("WICRO_LED TOGGLE\n");
            } else if (command[0] == 'S') {
                printf("WICRO_STATUS LED=%s\n", gpio_get_level(LED_GPIO) == 0 ? "ON" : "OFF");
            } else {
                printf("WICRO_UNKNOWN COMMAND\n");
            }
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}
