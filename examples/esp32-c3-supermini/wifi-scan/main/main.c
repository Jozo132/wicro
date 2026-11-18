#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "esp_wifi.h"
#include "esp_event.h"

static void scan_once(void)
{
    wifi_scan_config_t config = { 0 };
    esp_wifi_scan_start(&config, true);

    uint16_t count = 20;
    wifi_ap_record_t records[20];
    memset(records, 0, sizeof(records));
    esp_wifi_scan_get_ap_records(&count, records);

    printf("WICRO_WIFI_SCAN count=%u\n", count);
    for (uint16_t i = 0; i < count; ++i) {
        printf("WICRO_WIFI ssid=%s rssi=%d auth=%d\n", records[i].ssid, records[i].rssi, records[i].authmode);
    }
}

void app_main(void)
{
    esp_err_t result = nvs_flash_init();
    if (result == ESP_ERR_NVS_NO_FREE_PAGES || result == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        nvs_flash_init();
    }

    esp_netif_init();
    esp_event_loop_create_default();
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t wifi_config = WIFI_INIT_CONFIG_DEFAULT();
    esp_wifi_init(&wifi_config);
    esp_wifi_set_mode(WIFI_MODE_STA);
    esp_wifi_start();

    while (true) {
        scan_once();
        vTaskDelay(pdMS_TO_TICKS(10000));
    }
}
