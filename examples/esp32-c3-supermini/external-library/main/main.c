#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "wicro_math.h"

void app_main(void)
{
    int value = 0;
    while (true) {
        printf("WICRO_EXTERNAL_LIBRARY square(%d)=%d\n", value, wicro_square(value));
        value = (value + 1) % 20;
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}
