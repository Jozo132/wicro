# Shared STM32 Arduino support

The `stm32f103c8` and `stm32f401rc` presets support genuine STM32duino 3.0.0 Arduino firmware through the same LLVM/LLD WASM build engine in Web, Node/CLI and VS Code. Bare-metal examples remain available. Other STM32 families require explicit SDK selection rules, board/variant/startup and ABI metadata, then separate validation; preset metadata alone does not establish Arduino support.

| Target | Arduino recipe | Physical evidence |
|---|---|---|
| STM32F103C8 | Cortex-M3, 72 MHz, 64 KiB flash / 20 KiB RAM, PB2 LED, native USB CDC | 37,320-byte image uploaded and fully read back with ST-Link; 65 consecutive native USB heartbeat counters (800–864) over 65 seconds without disconnect or error. User confirmed browser Arduino compilation and browser ST-Link flashing. |
| STM32F401RC | Cortex-M4 hard float, 84 MHz, 256 KiB flash / 64 KiB RAM, native USB CDC | 39,520-byte image uploaded and fully read back; its own `jozo132/cdc-dfu` 1.1.2 hook re-entered ROM DFU for another upload; same CDC serial returned; 65-second uninterrupted heartbeat and identical offline rebuild passed. |

Automated real Chromium, CLI and VS Code host builds produce identical ELF/BIN outputs for both examples, including cached offline builds. Bundled Wire and SPI sources compile and link. The F401 example also initializes and closes those peripherals; communication with an external I2C/SPI device has not been verified.

## Build and upload

```sh
node packages/wicro/bin/wicro.js build --project=examples/stm32f103c8/arduino-usb-heartbeat
node packages/wicro/bin/wicro.js upload --project=examples/stm32f103c8/arduino-usb-heartbeat \
  --serial=16180c002c135737334d4e00 --uid=066cff353830484257085743
node packages/wicro/bin/wicro.js build --project=examples/stm32f401rc/arduino-usb-heartbeat
node packages/wicro/bin/wicro.js upload --project=examples/stm32f401rc/arduino-usb-heartbeat --serial=206635AE484E
```

Use the serial/UID of your hardware. In `npm run dev:web`, select the corresponding example, Build and Flash. Browser device selection needs a user gesture and OS USB access. F401 automatic DFU entry requires bridge-enabled firmware already running; the initial installation otherwise needs manual BOOT0/reset into ROM DFU. F103 USB CDC is the application console; programming uses ST-Link.

## On-demand SDK composition

The committed F1/F4 manifests pin each upstream archive's SHA-256 and an independently verified SHA-256 for the resulting SDK ZIP. The installer streams TAR.GZ extraction and retains only selected sources, headers, linker scripts, target ABI libraries and license files. It verifies archive paths, headers, selected-member bounds and derived archive identity before installation. Native compiler executables are never selected or executed. Compilation and linking use WASM, with genuine HAL/CMSIS, Arduino core, variants, startup assembly and ARM newlib/libstdc++ libraries.

Inputs are PlatformIO `framework-arduinoststm32` 4.30000.0, CMSIS 2.60300.0, ARM GNU target runtime 1.120301.0, and an exact LLVM ARM ACLE header plus its license. Component licenses remain applicable; the package's framework license does not replace licenses of included components. No SDK binaries or vendor archives are committed or published by this change.

A cold composition downloads approximately 295 MB of unmodified upstream archives because the target runtime is distributed together with native tools. Persistent raw-input caching allows the other family to reuse those downloads. Derived SDK ZIPs are approximately 10 MB (F1) and 13 MB (F4); installed SDKs and object files are cached persistently. Browser raw inputs use OPFS. `--offline` requires an installed SDK and compiler.

For development, `node scripts/package-stm32-sdk.js` reproduces both ZIPs in ignored `dist/assets/`, using the same installer composition implementation. Local archives remain hash checked.

## Production browser transport

The dev server supplies `/api/asset-download`. Production browser builds use
`/api/asset-download` on the application origin by default, or can override that
endpoint with `VITE_WICRO_ASSET_RELAY_URL`. Direct GitHub release/CDN downloads are not assumed to permit browser CORS. Node/CLI fetch upstream directly.

The prepared Cloudflare Worker permits only GET/HEAD/OPTIONS, exact hosts and permitted release/download paths, validates every redirect, strips credentials/cookies, preserves validated range responses and bounds response size. It streams upstream bytes and sets CORS headers. Deployment is an operator action; no account resources are created automatically.

## Validation

`tests/stm32-arduino.test.js` checks real WASM build parity and offline reuse across hosts. `tests/stm32-sdk-browser.test.js` composes both actual SDKs in a Chromium worker and verifies shared cached inputs without network access for the second composition. These explicitly skip when large local development inputs are absent. `tests/sdk-composition.test.js`, `tests/registry-relay.test.js` and `tests/arm-image-lma.test.js` cover archive validation, transport and initialized-data flash load addresses.

The opt-in `tests/stm32-arduino-hardware.test.js` requires explicit board/device selectors and checks upload/readback, 65 seconds of continuous CDC counters and an identical offline build. Hardware evidence is target-specific. A later repeat read-only F103 SWD session stalled and was stopped; the earlier full upload/readback passed, and the running application can be observed separately over USB without resetting or reflashing.

For non-invasive serial observation of already installed firmware, set `WICRO_STM32_CDC_ONLY=1` together with the hardware-test board/CDC selectors. This mode does not claim a new flash readback. F103 upload/readback and subsequent 65-second USB observation were separate successful operations.
