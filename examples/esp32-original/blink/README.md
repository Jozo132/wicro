# Original ESP32 blink

ESP-IDF blink firmware for the original ESP32 Xtensa dual-core board.

```sh
idf.py set-target esp32
idf.py build
idf.py -p /dev/ttyUSB0 flash monitor
```

Configuration:

- Xtensa LX6
- GPIO2, active-high LED
