# ESP8266 bare-metal UART heartbeat

Bootable RAM-only firmware built entirely with LLVM/LLD WASM. Select the
`esp8266-bare-metal` board, or load this example in `npm run dev:web`.

```sh
node packages/wicro/bin/wicro.js build --project=examples/esp8266/bare-metal-heartbeat
node packages/wicro/bin/wicro.js upload --project=examples/esp8266/bare-metal-heartbeat --port=/dev/ttyUSB0
node packages/wicro/bin/wicro.js monitor --port=/dev/ttyUSB0 --baud=115200
```

The profile requires an ESP8266, 4 MiB flash and 26 MHz crystal. Upload replaces
the ROM boot image at flash offset 0 and verifies every firmware byte. Firmware
prints `WICRO_ESP8266_READY` once and alternates GPIO2 LOW/HIGH messages while
feeding the hardware watchdog. It retains early ROM clocks, with a 52 MHz UART
clock, and provides no Arduino/Wi-Fi runtime. LED polarity and wiring vary by board.

See [physical evidence and limitations](../../../docs/esp8266-wasm-status.md).
