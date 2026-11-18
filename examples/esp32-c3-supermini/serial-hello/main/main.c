#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

void app_main(void)
{
    printf("WICRO_SERIAL_READY ESP32-C3 SuperMini\n");
    int count = 0;
    while (true) {
        printf("WICRO_HELLO %d\n", ++count);
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
