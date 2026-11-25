#include <Arduino.h>
#include <cdc_dfu.h>
#include <Wire.h>
#include <SPI.h>
unsigned long ticks = 0;
void setup() {
  pinMode(PC13, OUTPUT);
  Serial.begin(115200);
  Wire.begin(); Wire.end();
  SPI.begin(); SPI.end();
}
void loop() {
  digitalWrite(PC13, LOW);
  Serial.print("WICRO_STM32_ARDUINO_TICK ");
  Serial.println(++ticks);
  delay(500);
  digitalWrite(PC13, HIGH);
  delay(500);
}
