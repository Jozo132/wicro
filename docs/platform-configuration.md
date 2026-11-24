# Visual platform configuration

Run `npm run dev:web` and use **Configure** in the toolbar to open Platform setup.
The panel and the Monaco `wicro.json` editor edit the same project configuration.
Selecting a target preserves project sources; select an example explicitly to
replace the project with example files.

## Device and framework

Device family filters MCU models, and the selected model filters board presets.
Framework choices come from the shared platform registry or the board's declared
framework and generic bare-metal compilation support. The summary distinguishes
object-only presets from firmware recipes. An available preset or framework does
not imply complete SDK linkage or physically verified hardware operation.

CPU frequency displays the board metadata or the ESP32-C3 recipe's declared
frequency. Current presets do not implement an adjustable clock-control recipe,
so the field is disabled. Overclock choices are not inferred from MCU names.
Changing `F_CPU` alone would not configure hardware clocks. A `build.clockHz`
override is rejected by the browser configuration validator.

A non-Arduino framework combined with selected `.ino`/`.pde` sources disables
Build and explains the mismatch. Change the framework or edit the project sources.

## Build options

Optimization selects a real compiler flag (`-O0`, `-Og`, `-O1`, `-O2`, `-O3`,
`-Os`, `-Oz`, or `-Ofast`). Recipe default removes the project's optimization
flags and retains the recipe's defaults. Selecting another optimization replaces
only recognized optimization flags, preserving other arguments.

Debug symbols, common warnings, and extra warnings toggle `-g`, `-Wall`, and
`-Wextra`. Defines map to `build.defines`, one string per line, without `-D`.
Additional compiler flags map directly to `build.flags`, one argument per line.
These fields feed the shared WASM build engine; project flags/defines also feed
browser live diagnostics. Existing sources, dependencies, and custom build keys
are retained when a visual control changes.

## Programmer and upload

Programmer descriptors declare their browser upload protocols. Currently the
ESP32-C3 USB Serial/JTAG adapter exposes Espressif SLIP upload; its USB CDC reset
transport is not presented as a separate interchangeable upload protocol.
Other programmer descriptors remain unavailable in the browser. Web Serial must
also be available before a browser programmer can be selected for use.

Download artifacts only hides upload settings and disables Flash. With a supported
programmer, upload baud rate is editable. Verify after upload reveals byte-for-byte
flash readback verification. Open serial monitor after upload reveals the monitor
baud rate. These settings are persisted in the project's `upload` section:

```json
{
  "name": "my-project",
  "board": "esp32-c3-supermini",
  "framework": "arduino",
  "build": {
    "flags": ["-Os", "-g", "-Wall"],
    "defines": ["LOG_LEVEL=2"]
  },
  "upload": {
    "programmer": "esp32-c3-usb-jtag",
    "protocol": "esptool-slip",
    "baudRate": 460800,
    "verify": "readback",
    "autoMonitor": true,
    "monitorBaudRate": 115200
  }
}
```

The browser flashing service consumes the upload speed, verification choice,
automatic monitor choice, and monitor speed. The existing serial dock controls
stay synchronized with the same settings. Changing boards clears target-specific
upload overrides. This does not add upload implementations for other devices or
change CLI upload argument handling.

## Editing and validation

Edit JSON opens `wicro.json` in Monaco. Valid JSON edits update selectors,
checkboxes, and conditional fields immediately. Malformed JSON is preserved as
written; visual editing pauses and Build/Flash are disabled until it is repaired.
Unknown boards, incompatible frameworks/programmers/protocols, malformed string
arrays, and invalid baud rates are reported without silently replacing values.

Changing build configuration or source files invalidates firmware artifacts.
Changing upload preferences preserves a completed build. A build finishing after
the project was edited discards its artifacts and asks for a rebuild. Configuration
controls are disabled while building or flashing.

## Validation

`packages/core/test/platform-configuration.test.js` checks every registered board,
framework, and optimization combination, JSON recovery, preservation of custom
fields, and artifact invalidation. `tests/platform-configuration.test.js` drives
real Chromium controls and Monaco models, including desktop/mobile layouts.
`tests/web-ide.test.js` additionally compiles firmware with a preprocessor check
requiring a define entered through the visual UI, using the real WASM compiler.
No hardware upload verification is claimed by these UI/build tests.
