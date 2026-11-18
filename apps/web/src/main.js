import * as monaco from 'monaco-editor';
import { WASI, OpenFile, File, PreopenDirectory, ConsoleStdout } from '@bjorn3/browser_wasi_shim';
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
    <div class="target">ESP32-C3 SuperMini</div>
    <div class="actions">
      <button id="compile" type="button">Compile</button>
      <button id="connect" type="button" class="secondary">Connect</button>
      <button id="upload" type="button" class="primary" disabled>Upload</button>
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
    <span>RISC-V RV32IMC</span>
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

let serialPort = null;

/** @param {string} text */
const setStatus = (text) => {
  if (status) status.textContent = text;
};

compileButton?.addEventListener('click', async () => {
  setStatus('Loading ESP32-C3 LLVM WASM…');
  try {
    const response = await fetch('/toolchain/llvm.wasm');
    if (!response.ok) throw new Error(`Toolchain download failed (${response.status})`);

    const source = editor.getValue();
    const root = new PreopenDirectory('.', new Map([
      ['main.c', new File(new TextEncoder().encode(source))]
    ]));
    let stdout = '';
    let stderr = '';
    const wasi = new WASI([
      'clang',
      '--target=riscv32-esp-elf',
      '-march=rv32imc',
      '-mabi=ilp32',
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

    setStatus(`Compiled main.o (${Number(output.size)} bytes) for RISC-V RV32IMC`);
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
    serialPort = await navigator.serial.requestPort({
      filters: [{ usbVendorId: 0x303a, usbProductId: 0x1001 }]
    });
    await serialPort.open({ baudRate: 115200 });
    if (uploadButton) uploadButton.disabled = false;
    setStatus('Connected to ESP32-C3 SuperMini');

    const reader = serialPort.readable.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      while (serialPort?.readable) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && consoleOutput) consoleOutput.textContent += decoder.decode(value);
      }
      reader.releaseLock();
    })();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Serial connection failed');
  }
});

uploadButton?.addEventListener('click', () => {
  setStatus('Put the board in download mode, then use Wicro CLI upload for verified physical flashing');
});

document.querySelector('#clear')?.addEventListener('click', () => {
  if (consoleOutput) consoleOutput.textContent = '';
});

window.addEventListener('beforeunload', () => editor.dispose());
