import * as monaco from 'monaco-editor';
import { WASI, OpenFile, File, PreopenDirectory, ConsoleStdout } from '@bjorn3/browser_wasi_shim';
import { ESPLoader, Transport } from 'esptool-js';
import { WicroLanguageService } from '../../../packages/language-server/src/index.js';
import { BrowserSdkStorage } from '../../../packages/registry/src/browser-cache.js';
import { CompilerAssetManager } from '../../../packages/registry/src/compiler-assets.js';
import { preprocessIno } from '../../../packages/arduino/src/index.js';
import './style.css';

const defaultSource = `void setup()
{
    pinMode(LED_BUILTIN, OUTPUT);
}

void loop()
{
    digitalWrite(LED_BUILTIN, HIGH);
    delay(500);
    digitalWrite(LED_BUILTIN, LOW);
    delay(500);
}
`;

const app = document.querySelector('#app');

if (!app) throw new Error('Wicro app root not found');

app.innerHTML = `
  <header class="toolbar">
    <div class="brand"><span class="brand-mark">W</span><strong>Wicro</strong></div>
    <select id="target" class="target-select" aria-label="Board target">
      <option value="arduino-uno" selected>Arduino UNO</option>
      <option value="arduino-nano">Arduino Nano</option>
      <option value="arduino-mega">Arduino Mega 2560</option>
      <option value="arduino-leonardo">Arduino Leonardo</option>
      <option value="esp32-c3">ESP32-C3 SuperMini</option>
      <option value="esp32-devkit">ESP32 DevKit</option>
      <option value="esp32-s2">ESP32-S2</option>
      <option value="esp32-s3">ESP32-S3</option>
      <option value="esp32-c6">ESP32-C6</option>
      <option value="esp32-h2">ESP32-H2</option>
      <option value="esp32-original">Original ESP32</option>
      <option value="esp8266">ESP8266</option>
      <option value="esp8266-nodemcu">ESP8266 NodeMCU</option>
      <option value="esp8266-d1-mini">ESP8266 D1 Mini</option>
      <option value="stm32f103cb">STM32F103CB</option>
      <option value="stm32h723vg">STM32H723VG</option>
      <option value="stm32f401rc">STM32F401RC</option>
      <option value="stm32-blue-pill">STM32 Blue Pill</option>
      <option value="stm32-black-pill">STM32 Black Pill</option>
      <option value="stm32-nucleo-f401re">STM32 Nucleo-F401RE</option>
      <option value="rp2040">RP2040</option>
      <option value="rp2350">RP2350</option>
      <option value="raspberry-pi-pico-w">Raspberry Pi Pico W</option>
      <option value="raspberry-pi-pico-2">Raspberry Pi Pico 2</option>
      <option value="raspberry-pi-pico-2-w">Raspberry Pi Pico 2 W</option>
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
      <div class="panel-label">main.ino</div>
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
    <span id="target-status">AVR ATmega328P</span>
  </footer>
`;

const editorRoot = /** @type {HTMLElement} */ (document.querySelector('#editor'));
const editor = monaco.editor.create(editorRoot, {
  value: defaultSource,
  language: 'cpp',
  theme: 'vs-dark',
  automaticLayout: true,
  minimap: { enabled: false },
  fontFamily: 'JetBrains Mono, SFMono-Regular, Consolas, monospace',
  fontSize: 14,
  padding: { top: 18 }
});

/** @type {WebAssembly.Module|null} */
let browserWasmModule = null;

/** @returns {Promise<WebAssembly.Module>} */
const loadBrowserWasm = async () => {
  if (browserWasmModule) return browserWasmModule;
  const manifestResponse = await fetch('/toolchain/manifest.json', { cache: 'no-cache' });
  if (!manifestResponse.ok) throw new Error(`Toolchain manifest failed (${manifestResponse.status})`);
  const manifest = await manifestResponse.json();
  const storage = new BrowserSdkStorage();
  const localManifest = structuredClone(manifest);
  if (!localManifest.artifacts?.clang?.url) {
    localManifest.artifacts ??= {};
    localManifest.artifacts.clang.url = new URL('/toolchain/llvm.wasm', window.location.href).href;
  }
  const resolved = await new CompilerAssetManager({ storage }).ensure(localManifest);
  const compilerBytes = await storage.readBytes(resolved.clang);
  const response = { ok: true, status: 200, arrayBuffer: async () => compilerBytes.buffer.slice(compilerBytes.byteOffset, compilerBytes.byteOffset + compilerBytes.byteLength) };
  if (!response.ok) throw new Error(`Toolchain download failed (${response.status})`);
  browserWasmModule = await WebAssembly.compile(await response.arrayBuffer());
  return browserWasmModule;
};

/**
 * @param {string[]} args
 * @param {string} source
 * @param {string} [language]
 */
const runBrowserClang = async (args, source, language = 'c') => {
  const module = await loadBrowserWasm();
  const extension = language === 'c++' ? 'cpp' : 'c';
  const root = new PreopenDirectory('.', new Map([
    [`main.${extension}`, new File(new TextEncoder().encode(source))]
  ]));
  let stdout = '';
  let stderr = '';
  const wasi = new WASI([
    'clang',
    ...args,
    '-fsyntax-only',
    `main.${extension}`
  ], [], [
    new OpenFile(new File([])),
    ConsoleStdout.lineBuffered((line) => { stdout += `${line}\n`; }),
    ConsoleStdout.lineBuffered((line) => { stderr += `${line}\n`; }),
    root
  ]);
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
  const exitCode = wasi.start(/** @type {any} */ (instance));
  return { exitCode, stdout, stderr };
};

const browserLanguageToolchain = {
  /** @param {{source:string,target?:string,targetOptions?:{march?:string,mabi?:string,mcpu?:string,mcu?:string},language?:'c'|'c++',includeDirs?:string[],files?:Record<string,string|Uint8Array>,defines?:string[],line?:number,column?:number}} options */
  async diagnoseSource(options) {
    const targetName = options.target ?? 'riscv32';
    const configs = await loadTargetConfigs();
    const config = Object.values(configs).find((item) => item.build.target === targetName);
    const args = config ? buildArgs(config.build) : buildArgs({ target: 'riscv32', targetOptions: {} });
    const result = await runBrowserClang(args, options.source, options.language);
    const diagnostics = [];
    for (const line of result.stderr.split(/\r?\n/)) {
      const match = line.match(/^(.*?):(\d+):(\d+):\s+(fatal error|error|warning|note):\s*(.*)$/);
      if (!match) continue;
      diagnostics.push({ severity: match[4] === 'warning' ? 'warning' : match[4] === 'note' ? 'info' : 'error', file: match[1], line: Number(match[2]), column: Number(match[3]), message: match[5] });
    }
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, diagnostics };
  },
  /** @param {{source:string,target?:string,targetOptions?:{march?:string,mabi?:string,mcpu?:string,mcu?:string},language?:'c'|'c++',line:number,column:number}} options */
  async completeSource(options) {
    const targetName = options.target ?? 'riscv32';
    const configs = await loadTargetConfigs();
    const config = Object.values(configs).find((item) => item.build.target === targetName);
    const args = config ? buildArgs(config.build) : buildArgs({ target: 'riscv32', targetOptions: {} });
    const result = await runBrowserClang([...args, `-Xclang`, `-code-completion-at=main.c:${options.line}:${options.column}`], options.source, options.language);
    const candidates = [];
    for (const line of (result.stderr || result.stdout).split(/\r?\n/)) {
      const match = line.match(/^COMPLETION:\s*([^\s]+)(?:\s+:\s*(.*))?$/);
      if (match) candidates.push({ label: match[1], detail: match[2] ?? '' });
    }
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, candidates };
  },
  /** @returns {Promise<never>} */
  async runLanguageTool() {
    throw new Error('Clang-Tidy/Clang-Format WASM entry points are unavailable');
  }
};

const languageService = new WicroLanguageService({ host: 'browser', toolchain: /** @type {any} */ (browserLanguageToolchain), configuration: { target: 'riscv32' } });
const documentUri = 'file:///main.ino';
languageService.openDocument({ uri: documentUri, languageId: 'cpp', text: editor.getValue(), version: 1 });

monaco.languages.registerCompletionItemProvider('cpp', {
  /** @param {import('monaco-editor').editor.ITextModel} model @param {import('monaco-editor').Position} position */
  async provideCompletionItems(model, position) {
    languageService.updateDocument(documentUri, model.getValue(), 1);
    try {
      const items = await languageService.completion(documentUri, { line: position.lineNumber - 1, character: position.column - 1 });
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn
      };
      return { suggestions: items.map((item) => ({ label: item.label, insertText: item.label, detail: item.detail, kind: monaco.languages.CompletionItemKind.Text, range })) };
    } catch {
      return { suggestions: [] };
    }
  }
});

monaco.languages.registerHoverProvider('cpp', {
  /** @param {import('monaco-editor').editor.ITextModel} model @param {import('monaco-editor').Position} position */
  provideHover(model, position) {
    languageService.updateDocument(documentUri, model.getValue(), 1);
    const hover = languageService.hover(documentUri, { line: position.lineNumber - 1, character: position.column - 1 });
    if (!hover) return null;
    return { range: undefined, contents: [{ value: hover.contents.value }] };
  }
});

monaco.languages.registerDefinitionProvider('cpp', {
  /** @param {import('monaco-editor').editor.ITextModel} model @param {import('monaco-editor').Position} position */
  provideDefinition(model, position) {
    languageService.updateDocument(documentUri, model.getValue(), 1);
    return languageService.definition(documentUri, { line: position.lineNumber - 1, character: position.column - 1 }).map((location) => ({ uri: monaco.Uri.parse(location.uri), range: {
      startLineNumber: location.range.start.line + 1,
      startColumn: location.range.start.character + 1,
      endLineNumber: location.range.end.line + 1,
      endColumn: location.range.end.character + 1
    } }));
  }
});

monaco.languages.registerReferenceProvider('cpp', {
  /** @param {import('monaco-editor').editor.ITextModel} model @param {import('monaco-editor').Position} position */
  provideReferences(model, position) {
    languageService.updateDocument(documentUri, model.getValue(), 1);
    return languageService.references(documentUri, { line: position.lineNumber - 1, character: position.column - 1 }).map((location) => ({ uri: monaco.Uri.parse(location.uri), range: {
      startLineNumber: location.range.start.line + 1,
      startColumn: location.range.start.character + 1,
      endLineNumber: location.range.end.line + 1,
      endColumn: location.range.end.character + 1
    } }));
  }
});

monaco.languages.registerRenameProvider('cpp', {
  /** @param {import('monaco-editor').editor.ITextModel} model @param {import('monaco-editor').Position} position @param {string} newName */
  async provideRenameEdits(model, position, newName) {
    languageService.updateDocument(documentUri, model.getValue(), 1);
    const result = await languageService.rename(documentUri, { line: position.lineNumber - 1, character: position.column - 1 }, newName);
    const edits = Object.entries(result.changes).flatMap(([uri, changeEdits]) => changeEdits.map((edit) => ({ resource: monaco.Uri.parse(uri), textEdit: {
      range: {
        startLineNumber: edit.range.start.line + 1,
        startColumn: edit.range.start.character + 1,
        endLineNumber: edit.range.end.line + 1,
        endColumn: edit.range.end.character + 1
      }, text: edit.newText
    }, versionId: undefined })));
    return { edits };
  }
});

/** @param {string} text */
const updateBrowserDiagnostics = async (text) => {
  languageService.updateDocument(documentUri, text, 1);
  try {
    const diagnostics = await languageService.diagnostics(documentUri);
    const model = editor.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(model, 'wicro', diagnostics.map((diagnostic) => ({
      severity: diagnostic.severity === 'error' ? monaco.MarkerSeverity.Error : diagnostic.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
      message: diagnostic.message,
      startLineNumber: diagnostic.range.start.line + 1,
      startColumn: diagnostic.range.start.character + 1,
      endLineNumber: diagnostic.range.end.line + 1,
      endColumn: diagnostic.range.end.character + 1
    })));
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Language diagnostics failed');
  }
};

editor.onDidChangeModelContent(() => {
  void updateBrowserDiagnostics(editor.getValue());
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
    if (targetConfig) {
      languageService.configuration = {
        target: targetConfig.build.target,
        targetOptions: targetConfig.build.targetOptions
      };
      void updateBrowserDiagnostics(editor.getValue());
    }
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

    const wasm = await loadBrowserWasm();

    const sketchSource = editor.getValue();
    const useArduino = targetName === 'arduino-uno'
      || targetName === 'arduino-nano'
      || targetName === 'arduino-mega'
      || targetName === 'arduino-leonardo'
      || targetName === 'esp8266'
      || targetName === 'esp8266-nodemcu'
      || targetName === 'esp8266-d1-mini';
    const compiledSource = useArduino
      ? preprocessIno({ 'main.ino': sketchSource }).cpp
      : sketchSource;
    const extension = useArduino ? 'cpp' : 'c';
    const root = new PreopenDirectory('.', new Map([
      [`main.${extension}`, new File(new TextEncoder().encode(compiledSource))]
    ]));
    let stdout = '';
    let stderr = '';
    const wasi = new WASI([
      'clang',
      ...buildArgs(targetConfig.build),
      '-nostdlib',
      ...(useArduino ? ['-x', 'c++'] : []),
      '-c',
      `main.${extension}`,
      '-o',
      'main.o'
    ], [], [
      new OpenFile(new File([])),
      ConsoleStdout.lineBuffered((line) => { stdout += `${line}\n`; }),
      ConsoleStdout.lineBuffered((line) => { stderr += `${line}\n`; }),
      root
    ]);

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
