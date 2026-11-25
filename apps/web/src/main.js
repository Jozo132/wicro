import { LibraryPanel } from './ui/library-panel.js';
import { IdeStore } from './state/ide-store.js';
import { WicroBuildClient } from './services/build-client.js';
import { IdeDeviceService } from './services/device-service.js';
import { MonacoEditorHost } from './editor/monaco-host.js';
import { PlatformConfigurationPanel } from './ui/platform-configuration.js';
import { IdeShell } from './ui/ide-shell.js';
import './style.css';

const FALLBACK_EXAMPLE = {
  id: 'esp32-c3-supermini/blink',
  board: 'esp32-c3-supermini',
  name: 'blink',
  framework: 'arduino',
  files: {
    'main/main.ino': `void setup() {\n    Serial.begin(115200);\n    pinMode(8, OUTPUT);\n    Serial.println("WICRO_SERIAL_READY");\n}\n\nvoid loop() {\n    digitalWrite(8, LOW);\n    Serial.println("LED ON");\n    delay(500);\n\n    digitalWrite(8, HIGH);\n    Serial.println("LED OFF");\n    delay(500);\n}\n`,
    'wicro.json': JSON.stringify({
      name: 'esp32-c3-supermini-blink',
      board: 'esp32-c3-supermini',
      framework: 'arduino',
      toolchain: 'llvm-wasm',
      build: { sources: ['main/main.ino'] }
    }, null, 2)
  }
};

/** @param {string} filename @param {Uint8Array} bytes */
const triggerDownload = (filename, bytes) => {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const blob = new Blob([copy], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const bootstrap = async () => {
  const root = /** @type {HTMLElement | null} */ (document.querySelector('#app'));
  if (!root) throw new Error('Wicro app root (#app) not found');

  const store = new IdeStore();
  const buildClient = new WicroBuildClient();
  buildClient.onTransfer = (transfer) => { store.download = transfer; store.emit('download'); };

  const deviceService = new IdeDeviceService({
    onSerialLine: (line) => store.appendSerialLine(line),
    onDeviceStatus: (status) => {
      store.deviceConnected = status.connected;
      store.deviceState = status.state;
      store.deviceLabel = status.label;
      store.emit('device');
    },
    onLog: (line) => store.appendCompilerLog(`[Flash] ${line}`)
  });

  /** @type {ReturnType<typeof setTimeout> | null} */
  let diagnoseTimer = null;
  const scheduleDiagnostics = () => {
    if (diagnoseTimer) clearTimeout(diagnoseTimer);
    diagnoseTimer = setTimeout(async () => {
      if (store.buildStatus === 'building' || store.configurationIssues.length) return;
      try {
        const res = await buildClient.diagnose({
          boardId: store.boardId,
          projectFiles: store.snapshotFiles(),
          activeFile: store.activeFile
        });
        if (Array.isArray(res?.diagnostics)) {
          store.diagnostics = res.diagnostics;
          editorHost.setDiagnostics(res.diagnostics);
          store.emit('diagnostics');
        }
      } catch {
        // Live diagnostics are best-effort until the compiler is loaded.
      }
    }, 650);
  };

  const refreshCacheStatus = async () => {
    try {
      store.cacheInfo = await buildClient.cacheStatus();
      store.emit('cache');
    } catch {
      // Ignore transient worker errors.
    }
  };

  const runBuild = async (/** @type {{clean?:boolean}} */ options = {}) => {
    if (store.buildStatus === 'building') return null;
    if (store.configurationIssues.length) {
      store.appendCompilerLog(`[Configuration] ${store.configurationIssues.join(' ')}`);
      return null;
    }
    const buildSnapshot = JSON.stringify(store.snapshotFiles());
    store.buildStatus = 'building';
    store.buildProgress = { stage: 'start', message: 'Starting WASM build…', percent: 2 };
    store.clearCompilerLogs();
    store.appendCompilerLog(`[Wicro] Building ${store.exampleId || 'project'} for ${store.boardId} (${store.framework})${store.offline ? ' [OFFLINE]' : ''}…`);
    store.emit('build');
    shell.setActiveBottomTab('output');

    try {
      const result = await buildClient.build(
        {
          boardId: store.boardId,
          framework: store.framework,
          projectFiles: store.snapshotFiles(),
          offline: store.offline,
          clean: options.clean
        },
        (progress) => {
          if (progress.transfer) return;
          store.buildProgress = {
            stage: progress.stage,
            message: progress.message,
            percent: progress.percent ?? store.buildProgress.percent
          };
          store.appendCompilerLog(`[${progress.stage}] ${progress.message}`);
          store.emit('build');
        }
      );

      if (buildSnapshot !== JSON.stringify(store.snapshotFiles())) {
        store.lastBuild = null;
        store.buildStatus = 'idle';
        store.buildProgress = { stage: 'idle', message: 'Project changed during build; rebuild to use the latest configuration.', percent: 0 };
        store.appendCompilerLog('[Wicro] Discarded build artifacts because the project changed during compilation.');
        store.emit('build');
        return null;
      }
      for (const [path, content] of Object.entries(result.projectUpdates ?? {})) store.files.set(path, String(content));
      editorHost.syncFiles(store.files, store.activeFile);
      store.emit('project');
      store.lastBuild = result;
      store.diagnostics = result.parsedDiagnostics ?? [];
      editorHost.setDiagnostics(store.diagnostics);
      store.emit('diagnostics');

      if (result.ok) {
        store.buildStatus = 'success';
        const binBytes = result.artifacts?.bin?.byteLength ?? result.artifacts?.object?.byteLength ?? 0;
        const cacheTag = `compiler=${result.cacheStatus.compiler}, sdk=${result.cacheStatus.sdk}`;
        store.buildProgress = {
          stage: 'done',
          message: `Build succeeded in ${(result.timingMs / 1000).toFixed(2)}s (${binBytes.toLocaleString()} B)`,
          percent: 100
        };
        store.appendCompilerLog(`[Wicro] Build succeeded in ${(result.timingMs / 1000).toFixed(2)}s (${cacheTag})`);
        if (result.value?.validation) {
          const v = result.value.validation;
          store.appendCompilerLog(`[Wicro] Firmware validated: entry=0x${(v.entry ?? 0).toString(16)}, segments=${v.segmentCount}, sha256=${v.sha256Valid ? 'OK' : 'N/A'}`);
        }
        if (result.value?.memory) {
          const m = result.value.memory;
          store.appendCompilerLog(`[Wicro] Memory: Flash ${m.totalFlashBytes.toLocaleString()} B (text=${m.textBytes}, rodata=${m.rodataBytes}, data=${m.dataBytes}), RAM ${m.totalRamBytes.toLocaleString()} B (bss=${m.bssBytes})`);
        }
      } else {
        store.buildStatus = 'error';
        const errorText = (result.diagnostics ?? []).map((/** @type {any} */ d) => d.message).join('\n') || 'Build failed';
        store.buildProgress = { stage: 'error', message: 'Build failed — see Problems / Output', percent: 0 };
        store.appendCompilerLog(`[Error] ${errorText}`);
        if (store.diagnostics.length > 0) shell.setActiveBottomTab('diagnostics');
      }

      store.emit('build');
      await refreshCacheStatus();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.buildStatus = 'error';
      store.buildProgress = { stage: 'error', message: `Build failed: ${message}`, percent: 0 };
      store.appendCompilerLog(`[Error] ${message}`);
      store.emit('build');
      return null;
    }
  };

  const runFlash = async () => {
    if (store.configurationIssues.length || store.uploadSettings.programmer === 'none') {
      store.appendCompilerLog('[Flash] Select a valid programmer and platform configuration first.');
      return null;
    }
    const board = store.currentBoard ? { ...store.currentBoard, metadata: { ...store.currentBoard.metadata, uploadBaud: store.uploadSettings.baudRate } } : null;
    const firmwareBin = store.lastBuild?.artifacts?.bin;
    if (!board || !(firmwareBin instanceof Uint8Array) || firmwareBin.byteLength === 0) {
      store.appendCompilerLog('[Flash] Build firmware first before flashing.');
      return null;
    }

    store.flashStatus = 'flashing';
    store.flashProgress = { stage: 'connect', message: 'Preparing USB flash…', percent: 2 };
    store.emit('flash');
    shell.setActiveBottomTab('output');

    try {
      const result = await deviceService.flashFirmware({
        board,
        firmwareBin,
        verifyReadback: store.verifyReadback,
        autoMonitor: store.autoMonitorAfterFlash,
        monitorBaudRate: store.baudRate,
        onProgress: (progress) => {
          store.flashProgress = {
            stage: progress.stage,
            message: progress.message,
            percent: progress.percent ?? store.flashProgress.percent
          };
          store.appendCompilerLog(`[Flash:${progress.stage}] ${progress.message}`);
          store.emit('flash');
        }
      });

      store.flashStatus = 'success';
      store.flashProgress = { stage: 'done', message: `Flashed ${result.chip} (${firmwareBin.byteLength.toLocaleString()} B)`, percent: 100 };
      const mac = 'mac' in result ? result.mac : undefined;
      store.appendCompilerLog(`[Flash] Complete: chip=${result.chip}${mac ? `, mac=${mac}` : ''}${result.readback?.verified ? ', readback=VERIFIED' : ''}`);
      store.emit('flash');
      if (store.autoMonitorAfterFlash) shell.setActiveBottomTab('serial');
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.flashStatus = 'error';
      store.flashProgress = { stage: 'error', message: `Flash failed: ${message}`, percent: 0 };
      store.appendCompilerLog(`[Flash Error] ${message}`);
      store.emit('flash');
      return null;
    }
  };

  const toggleMonitor = async () => {
    if (store.deviceConnected) {
      await deviceService.disconnectMonitor();
      return;
    }
    if (store.configurationIssues.length) {
      store.appendCompilerLog('[Monitor] Correct the platform configuration first.');
      return;
    }
    try {
      shell.setActiveBottomTab('serial');
      await deviceService.connectMonitor(store.currentBoard, store.baudRate);
      store.appendSerialLine({ text: `Connected at ${store.baudRate} baud`, timestamp: Date.now(), direction: 'system' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.appendSerialLine({ text: `Connection failed: ${message}`, timestamp: Date.now(), direction: 'system' });
    }
  };

  const shell = new IdeShell(root, store, {
    capabilities: deviceService.capabilities,
    onSelectBoard: (boardId) => {
      store.setBoard(boardId);
    },
    onSelectFramework: (framework) => store.setFramework(framework),
    onSelectExample: (exampleId) => {
      const example = store.examples.find((ex) => ex.id === exampleId);
      if (example) {
        store.loadExample(example);
        editorHost.syncFiles(store.files, store.activeFile);
      }
    },
    onSelectFile: (path) => {
      store.setActiveFile(path);
      editorHost.openFile(path);
    },
    onAddFile: (path) => {
      try {
        store.addFile(path, '');
        editorHost.syncFiles(store.files, store.activeFile);
      } catch (error) {
        store.appendCompilerLog(`[Project] ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    onDeleteFile: (path) => {
      store.deleteFile(path);
      editorHost.syncFiles(store.files, store.activeFile);
    },
    onBuild: (options) => { void runBuild(options); },
    onFlash: () => { void runFlash(); },
    onTransferControl: (action) => { if (store.download) buildClient.controlTransfer(store.download.requestId, action); },
    onToggleMonitor: () => { void toggleMonitor(); },
    onSendSerial: (text) => {
      void deviceService.sendSerial(text, store.lineEnding).catch((error) => {
        store.appendSerialLine({ text: `Write failed: ${error instanceof Error ? error.message : String(error)}`, timestamp: Date.now(), direction: 'system' });
      });
    },
    onDownloadArtifact: (kind) => {
      const data = store.lastBuild?.artifacts?.[kind];
      if (!(data instanceof Uint8Array)) return;
      const ext = kind === 'bin' ? 'firmware.bin' : kind === 'elf' ? 'firmware.elf' : kind === 'uf2' ? 'firmware.uf2' : 'main.o';
      triggerDownload(`${store.boardId}-${ext}`, data);
    },
    onClearCache: async () => {
      store.cacheInfo = await buildClient.clearCache();
      store.emit('cache');
      store.appendCompilerLog('[Cache] Cleared persistent WASM toolchain and SDK cache.');
    },
    onRevealDiagnostic: (file, line, column) => {
      if (store.files.has(file)) store.setActiveFile(file);
      editorHost.revealLocation(file, line, column);
    }
  });

  const editorHost = new MonacoEditorHost(shell.editorContainer, {
    theme: store.theme,
    onChange: (path, value) => {
      store.setFileContent(path, value);
      scheduleDiagnostics();
    },
    onComplete: async (path, line, column) => {
      if (store.buildStatus === 'building' || store.configurationIssues.length) return [];
      const res = await buildClient.complete({
        boardId: store.boardId,
        projectFiles: store.snapshotFiles(),
        activeFile: path,
        line,
        column
      });
      return Array.isArray(res?.candidates) ? res.candidates : [];
    }
  });

  store.subscribe((changed) => {
    if (changed === 'theme') editorHost.setTheme(store.theme);
    if (changed === 'configuration') {
      editorHost.syncFiles(store.files, store.activeFile);
      scheduleDiagnostics();
    }
  });

  new PlatformConfigurationPanel(/** @type {HTMLElement} */ (root.querySelector('#wicro-platform-configuration')), store, {
    webSerial: deviceService.capabilities.webSerial,
    webUsb: deviceService.capabilities.webUsb,
    onEnterRom: () => { void deviceService.enterRp2040Rom(store.currentBoard?.metadata?.platform === 'raspberrypi-rp2350').catch((error) => store.appendCompilerLog(`[RP2] ${error instanceof Error ? error.message : String(error)}`)); },
    onEnterDfu: () => { void deviceService.enterCdcDfu(store.currentBoard).catch((error) => store.appendCompilerLog(`[DFU] ${error instanceof Error ? error.message : String(error)}`)); },
    onEditJson: () => { store.setActiveFile('wicro.json'); editorHost.openFile('wicro.json'); }
  });

  new LibraryPanel(/** @type {HTMLElement} */ (root.querySelector('#wicro-library-panel')), store, buildClient, () => editorHost.syncFiles(store.files, store.activeFile));

  // Load canonical board catalog and example projects from Vite / static endpoints
  try {
    const [boardsResp, examplesResp] = await Promise.all([
      fetch('/registry/boards.json', { cache: 'no-cache' }),
      fetch('/examples/index.json', { cache: 'no-cache' })
    ]);
    if (boardsResp.ok) store.setBoards(await boardsResp.json());
    if (examplesResp.ok) store.setExamples(await examplesResp.json());
  } catch {
    // Offline fallback uses FALLBACK_EXAMPLE below.
  }

  const initialExample = store.examples.find((ex) => ex.id === 'esp32-c3-supermini/blink') ?? store.examples[0] ?? FALLBACK_EXAMPLE;
  let restored = null;
  try { const saved = localStorage.getItem('wicro-project-v1'); if (saved) restored = JSON.parse(saved); }
  catch (error) { store.appendCompilerLog(`[Project storage] ${error instanceof Error ? error.message : String(error)}`); }
  store.loadExample(restored?.files ? { id: restored.exampleId ?? 'saved-project', name: 'Saved project', board: restored.boardId ?? initialExample.board, framework: restored.framework ?? initialExample.framework, files: restored.files } : initialExample);
  if (restored?.activeFile) store.setActiveFile(restored.activeFile);
  store.subscribe((changed) => {
    if (!['configuration', 'file-content', 'project', 'active-file'].includes(changed)) return;
    try {
      localStorage.setItem('wicro-project-v1', JSON.stringify({ files: store.snapshotFiles(), exampleId: store.exampleId, boardId: store.boardId, framework: store.framework, activeFile: store.activeFile }));
    } catch (error) { store.appendCompilerLog(`[Project storage] ${error instanceof Error ? error.message : String(error)}`); }
  });
  editorHost.syncFiles(store.files, store.activeFile);
  await refreshCacheStatus();

  // Expose a clean debugging/automation API on window for Playwright E2E tests
  /** @type {any} */ (window).__wicroIde = {
    store,
    buildClient,
    deviceService,
    editorHost,
    runBuild,
    runFlash,
    refreshCacheStatus
  };

  window.addEventListener('beforeunload', () => {
    editorHost.dispose();
    buildClient.dispose();
    deviceService.dispose();
  });
};

void bootstrap();
