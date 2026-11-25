void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(115200);
  Serial.println("WICRO_NANO_READY");
}
void loop() {
  digitalWrite(LED_BUILTIN, LOW);
  Serial.println("WICRO_NANO_TICK LOW");
  delay(500);
  digitalWrite(LED_BUILTIN, HIGH);
  Serial.println("WICRO_NANO_TICK HIGH");
  delay(500);
}
