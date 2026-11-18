# Wicro

Wicro is a universal embedded development platform for browsers, VS Code, and Node.js. It uses a shared ESM core, host-specific adapters and WebAssembly tooling.

The npm package is `@jozo132/wicro`. Its command-line executable is `wicro`.

## Verified now

- Node.js CLI and npm/npx installation
- Strict JSDoc source checking
- Package manifest, semver, archive and virtual filesystem foundations
- Parallel build task DAG with cycle detection
- RISC-V WebAssembly compiler execution for ELF32 object generation
- ESP32-C3 SuperMini hardware discovery through USB-Serial/JTAG
- ESP-IDF v6.1.1 blink firmware build and flash
- GPIO8 active-low LED, serial heartbeat and 4 MB flash detection on hardware
- Monaco browser IDE shell and Web Serial controls

## Quick start

Run the CLI without installation:

```sh
npx @jozo132/wicro --help
```

Or install it globally:

```sh
npm install -g @jozo132/wicro
wicro --help
wicro doctor --json
wicro device list --json
```

ESP32-C3 SuperMini commands:

```sh
wicro build --project=examples/esp32-c3-supermini/blink
wicro upload --project=examples/esp32-c3-supermini/blink --port=/dev/ttyACM0
wicro monitor --port=/dev/ttyACM0 --baud=115200
```

The connected test board uses USB-Serial/JTAG VID/PID `303a:1001`, GPIO8 for the active-low onboard blue LED and BOOT on GPIO9.

## Browser IDE

```sh
npm run dev:web
```

Open `http://localhost:5173`. The editor supports browser-side RV32IMC compilation with the LLVM WASM toolchain. Web Serial is used for device connection; flashing beyond the browser shell should use the Node CLI until browser flashing is complete.

## Development

```sh
npm install
npm test
npm run check:types
npm run build:web
npm run pack:check
```

For ESP-IDF firmware work, the reference environment is staged under `toolchain/esp32-c3/esp-idf` and ignored by Git.

## Repository status

In progress:

- Full WASM firmware linking and ESP firmware image generation
- Incremental object caching and header dependency tracking
- PlatformIO, Arduino and CMSIS registry adapters
- VS Code extension integration
- Complete browser upload and monitor implementation

See [docs/compatibility.md](docs/compatibility.md) for the current implemented, planned and hardware-verified matrix.

No package is published by repository scripts or tests. Public publishing requires separate explicit approval.
