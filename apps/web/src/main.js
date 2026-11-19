import * as monaco from 'monaco-editor';
import { WASI, OpenFile, File, PreopenDirectory, ConsoleStdout } from '@bjorn3/browser_wasi_shim';
import { ESPLoader, Transport } from 'esptool-js';
import './style.css';

const defaultSource = `int main(void)
{
    volatile int blink = 0;
    return blink;
}
`;

const app = document.querySelector('#app');

if (!app) throw new Error('Wicro app root not found');

app.innerHTML = `
  <header class="toolbar">
    <div class="brand"><span class="brand-mark">W</span><strong>Wicro</strong></div>
    <select id="target" class="target-select" aria-label="Board target">
      <option value="esp32-c3">ESP32-C3 SuperMini</option>
      <option value="esp32-original">Original ESP32</option>
      <option value="esp8266">ESP8266</option>
      <option value="stm32f103cb">STM32F103CB</option>
      <option value="stm32h723vg">STM32H723VG</option>
      <option value="stm32f401rc">STM32F401RC</option>
      <option value="rp2040">RP2040</option>
      <option value="rp2350">RP2350</option>
      <option value="arduino-uno">Arduino UNO</option>
    </select>
    <div class="actions">
      <button id="compile" type="button">Compile</button>
      <button id="connect" type="button" class="secondary">Connect</button>
      <button id="upload" type="button" class="primary" disabled>Upload</button>
      <input id="firmware" type="file" accept=".bin" hidden>
    </div>
  </header>
  <main class="workspace">
    <section class="editor-panel">
      <div class="panel-label">main.c</div>
      <div id="editor"></div>
    </section>
    <aside class="console-panel">
      <div class="console-header">
        <span>Serial monitor</span>
        <button id="clear" type="button" aria-label="Clear serial output">Clear</button>
      </div>
      <pre id="console" aria-live="polite"></pre>
    </aside>
  </main>
  <footer class="statusbar">
    <span id="status">Toolchain not installed</span>
    <span id="target-status">RISC-V RV32IMC</span>
  </footer>
`;

const editorRoot = /** @type {HTMLElement} */ (document.querySelector('#editor'));
const editor = monaco.editor.create(editorRoot, {
  value: defaultSource,
  language: 'c',
  theme: 'vs-dark',
  automaticLayout: true,
  minimap: { enabled: false },
  fontFamily: 'JetBrains Mono, SFMono-Regular, Consolas, monospace',
  fontSize: 14,
  padding: { top: 18 }
});

/** @type {HTMLElement|null} */
const status = document.querySelector('#status');
/** @type {HTMLElement|null} */
const consoleOutput = document.querySelector('#console');
/** @type {HTMLButtonElement|null} */
const uploadButton = document.querySelector('#upload');
/** @type {HTMLButtonElement|null} */
const compileButton = document.querySelector('#compile');
/** @type {HTMLButtonElement|null} */
const connectButton = document.querySelector('#connect');

/** @type {any} */ let serialPort = null;
/** @type {any} */ let serialTransport = null;
/** @typedef {Blob & {name:string,arrayBuffer():Promise<ArrayBuffer>}} FirmwareFile */
/** @type {FirmwareFile|null} */ let firmwareFile = null;

const targetSelect = /** @type {HTMLSelectElement|null} */ (document.querySelector('#target'));
const firmwareInput = /** @type {HTMLInputElement|null} */ (document.querySelector('#firmware'));

/** @typedef {{label:string,build:{target:'riscv32'|'xtensa'|'armv7-m'|'armv7e-m'|'armv6m'|'armv8m-mainline'|'avr',targetOptions:{march?:string,mabi?:string,mcpu?:string,mcu?:string}}}} BoardConfig */
/** @type {Record<string,BoardConfig>|null} */
let targetConfigs = null;

/** @returns {Promise<Record<string,BoardConfig>>} */
const loadTargetConfigs = async () => {
  if (targetConfigs) return targetConfigs;
  const response = await fetch('/boards.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Board manifest failed (${response.status})`);
  targetConfigs = /** @type {Record<string,BoardConfig>} */ (await response.json());
  return targetConfigs;
};

/** @param {BoardConfig['build']} build */
const buildArgs = (build) => {
  if (build.target === 'riscv32') return ['--target=riscv32-esp-elf', `-march=${build.targetOptions.march ?? 'rv32imc'}`, `-mabi=${build.targetOptions.mabi ?? 'ilp32'}`];
  if (build.target === 'xtensa') return ['--target=xtensa-esp-elf', `-mcpu=${build.targetOptions.mcpu ?? 'esp32'}`];
  if (build.target === 'avr') return ['--target=avr', `-mmcu=${build.targetOptions.mcu ?? 'atmega328p'}`];
  if (build.target === 'armv6m') return ['--target=arm-none-eabi', `-mcpu=${build.targetOptions.mcpu ?? 'cortex-m0plus'}`, '-mthumb'];
  if (build.target === 'armv7-m') return ['--target=arm-none-eabi', `-mcpu=${build.targetOptions.mcpu ?? 'cortex-m3'}`, '-mthumb', '-mfloat-abi=soft'];
  if (build.target === 'armv7e-m') return ['--target=arm-none-eabi', `-mcpu=${build.targetOptions.mcpu ?? 'cortex-m4'}`, '-mthumb', '-mfloat-abi=hard'];
  return ['--target=arm-none-eabi', `-mcpu=${build.targetOptions.mcpu ?? 'cortex-m33'}`, '-mthumb', '-mfloat-abi=hard'];
};

/** @param {string} text */
const setStatus = (text) => {
  if (status) status.textContent = text;
};

targetSelect?.addEventListener('change', async () => {
  const targetName = targetSelect.value;
  const targetStatus = document.querySelector('#target-status');
  try {
    const configs = await loadTargetConfigs();
    const targetConfig = configs[targetName];
    if (targetStatus && targetConfig) targetStatus.textContent = targetConfig.label;
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Board manifest failed');
  }
});

compileButton?.addEventListener('click', async () => {
  setStatus('Loading shared LLVM WASM toolchain…');
  try {
    const targetName = targetSelect?.value ?? 'esp32-c3';
    const configs = await loadTargetConfigs();
    const targetConfig = configs[targetName];
    if (!targetConfig) throw new Error(`Unknown board target: ${targetName}`);

    const manifestResponse = await fetch('/toolchain/manifest.json', { cache: 'no-cache' });
    if (!manifestResponse.ok) throw new Error(`Toolchain manifest failed (${manifestResponse.status})`);
    const manifest = await manifestResponse.json();

    const compilerUrl = new URL(manifest.tools.clang.url, new URL('/toolchain/', window.location.href));
    const response = await fetch(compilerUrl);
    if (!response.ok) throw new Error(`Toolchain download failed (${response.status})`);

    const source = editor.getValue();
    const root = new PreopenDirectory('.', new Map([
      ['main.c', new File(new TextEncoder().encode(source))]
    ]));
    let stdout = '';
    let stderr = '';
    const wasi = new WASI([
      'clang',
      ...buildArgs(targetConfig.build),
      '-nostdlib',
      '-c',
      'main.c',
      '-o',
      'main.o'
    ], [], [
      new OpenFile(new File([])),
      ConsoleStdout.lineBuffered((line) => { stdout += `${line}\n`; }),
      ConsoleStdout.lineBuffered((line) => { stderr += `${line}\n`; }),
      root
    ]);

    const wasm = await WebAssembly.compile(await response.arrayBuffer());
    const instance = await WebAssembly.instantiate(wasm, {
      wasi_snapshot_preview1: wasi.wasiImport
    });
    const exitCode = wasi.start(/** @type {any} */ (instance));

    const output = root.dir.contents.get('main.o');
    if (exitCode !== 0 || !(output instanceof File) || output.size === 0n) {
      throw new Error(stderr || stdout || `Compiler exited with status ${exitCode}`);
    }

    setStatus(`Compiled main.o (${Number(output.size)} bytes) for ${targetConfig.label}`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Compile failed');
  }
});

connectButton?.addEventListener('click', async () => {
  if (!('serial' in navigator)) {
    setStatus('Web Serial is unavailable; use Chrome or Edge');
    return;
  }

  try {
    if (serialTransport) await serialTransport.disconnect();
    serialPort = await navigator.serial.requestPort({});
    serialTransport = new Transport(/** @type {any} */ (serialPort), false);
    await serialTransport.connect(115200);
    if (uploadButton) uploadButton.disabled = false;
    setStatus('Connected serial port');

    const decoder = new TextDecoder();
    void serialTransport.rawRead((/** @type {Uint8Array} */ data) => {
      if (consoleOutput) consoleOutput.textContent += decoder.decode(data);
    }, () => false);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Serial connection failed');
  }
});

firmwareInput?.addEventListener('change', () => {
  firmwareFile = /** @type {FirmwareFile|null} */ (firmwareInput.files?.[0] ?? null);
  setStatus(firmwareFile ? `Firmware selected: ${firmwareFile.name}` : 'No firmware selected');
});

uploadButton?.addEventListener('click', async () => {
  const targetName = targetSelect?.value ?? 'esp32-c3';
  if (targetName !== 'esp32-c3' && targetName !== 'esp32-original') {
    setStatus('Browser upload currently supports Espressif ESP32 targets');
    return;
  }
  if (!firmwareFile) {
    firmwareInput?.click();
    setStatus('Choose a firmware .bin file');
    return;
  }
  if (!('serial' in navigator)) {
    setStatus('Web Serial is unavailable; use Chrome or Edge');
    return;
  }

  try {
    if (serialTransport) {
      await serialTransport.disconnect();
      serialTransport = null;
    }
    serialPort = serialPort ?? await navigator.serial.requestPort({});
    const transport = new Transport(/** @type {any} */ (serialPort), false);
    const terminal = {
      clean: () => {},
      write: (/** @type {string} */ text) => { if (consoleOutput) consoleOutput.textContent += text; },
      writeLine: (/** @type {string} */ text) => { if (consoleOutput) consoleOutput.textContent += `${text}\n`; }
    };
    const loader = new ESPLoader({
      transport,
      baudrate: 115200,
      romBaudrate: 115200,
      terminal
    });

    setStatus('Connecting to Espressif ROM…');
    await loader.main('default_reset');
    await loader.writeFlash({
      fileArray: [{ data: new Uint8Array(await firmwareFile.arrayBuffer()), address: 0x10000 }],
      flashMode: 'dio',
      flashFreq: '40m',
      flashSize: 'detect',
      eraseAll: false,
      compress: true,
      reportProgress: (_fileIndex, written, total) => setStatus(`Flashing: ${Math.round(written / total * 100)}%`)
    });
    await transport.disconnect();
    serialPort = null;
    setStatus(`Uploaded ${firmwareFile.name}`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Upload failed');
  }
});

document.querySelector('#clear')?.addEventListener('click', () => {
  if (consoleOutput) consoleOutput.textContent = '';
});

window.addEventListener('beforeunload', () => editor.dispose());
