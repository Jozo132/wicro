#include <Adafruit_SSD1306.h>
#include <PubSubClient.h>

// This example demonstrates real library compilation and linking. Confirm the
// OLED wiring and I2C pins for your board before running it on hardware.
Adafruit_SSD1306 display(128, 64, &Wire, -1);
PubSubClient mqtt;

void setup() {
    if (display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
        display.clearDisplay();
        display.drawPixel(4, 4, SSD1306_WHITE);
        display.display();
    }
    // Supply a connected Arduino Client and your broker before using MQTT.
    mqtt.setServer("test.example", 1883);
}

void loop() {}
