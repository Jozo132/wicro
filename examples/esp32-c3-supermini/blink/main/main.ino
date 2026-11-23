void setup() {
    Serial.begin(115200);
    pinMode(8, OUTPUT);
    Serial.println("WICRO_SERIAL_READY");
}

void loop() {
    digitalWrite(8, LOW);
    Serial.println("LED ON");
    delay(500);

    digitalWrite(8, HIGH);
    Serial.println("LED OFF");
    delay(500);
}
