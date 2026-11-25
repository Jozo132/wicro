#include <Arduino.h>
#include <Wire.h>
#include <SPI.h>
unsigned long ticks = 0;
void setup() {
  pinMode(PB2, OUTPUT);
  Serial.begin(115200);
}
void loop() {
  digitalWrite(PB2, LOW);
  Serial.print("WICRO_STM32_ARDUINO_TICK ");
  Serial.println(++ticks);
  delay(500);
  digitalWrite(PB2, HIGH);
  delay(500);
}
