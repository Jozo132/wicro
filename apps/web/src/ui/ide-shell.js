import { getTargetConfiguration } from '../../../../packages/core/src/platform/configuration.js';

/**
 * Modular, responsive vanilla-ESM UI shell for the Wicro browser embedded IDE.
 * Renders toolbar, resizable file explorer, Monaco editor host, tabbed compiler/diagnostics/serial dock,
 * and status bar driven strictly by `IdeStore` and action callbacks.
 */

/** @param {number} bytes */
const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

/** @param {number} ts */
const formatTimestamp = (ts) => {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
};

/**
 * Wire a pointer-driven splitter to resize a CSS custom property on the IDE root.
 * @param {HTMLElement} handle
 * @param {HTMLElement} root
 * @param {string} cssVar
 * @param {'horizontal'|'vertical'} axis
 * @param {number} minPx
 * @param {number} maxPx
 */
const attachSplitter = (handle, root, cssVar, axis, minPx, maxPx) => {
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const startPos = axis === 'horizontal' ? event.clientX : event.clientY;
    const current = Number.parseFloat(getComputedStyle(root).getPropertyValue(cssVar)) || (axis === 'horizontal' ? 240 : 240);

    const onMove = (/** @type {PointerEvent} */ moveEvent) => {
      const delta = axis === 'horizontal'
        ? moveEvent.clientX - startPos
        : startPos - moveEvent.clientY;
      const next = Math.max(minPx, Math.min(maxPx, current + delta));
      root.style.setProperty(cssVar, `${next}px`);
    };

    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
};

export class IdeShell {
  /**
   * @param {HTMLElement} root
   * @param {import('../state/ide-store.js').IdeStore} store
   * @param {{
   *   capabilities: {webSerial:boolean,webUsb:boolean,opfs:boolean,warnings:string[]},
   *   onSelectBoard: (boardId: string) => void,
   *   onSelectFramework: (framework: string) => void,
   *   onSelectExample: (exampleId: string) => void,
   *   onSelectFile: (path: string) => void,
   *   onAddFile: (path: string) => void,
   *   onDeleteFile: (path: string) => void,
   *   onBuild: (options: {clean?:boolean}) => void,
   *   onFlash: () => void,
   *   onTransferControl: (action:'pause'|'resume'|'cancel') => void,
   *   onToggleMonitor: () => void,
   *   onSendSerial: (text: string) => void,
   *   onDownloadArtifact: (kind: 'bin'|'elf'|'object') => void,
   *   onClearCache: () => void,
   *   onRevealDiagnostic: (file: string, line: number, column: number) => void
   * }} actions
   */
  constructor(root, store, actions) {
    this.root = root;
    this.store = store;
    this.actions = actions;
    this.renderShell();

    this.editorContainer = /** @type {HTMLElement} */ (this.root.querySelector('#wicro-editor-container'));
    this.boardSelect = /** @type {HTMLSelectElement} */ (this.root.querySelector('#wicro-board'));
    this.frameworkSelect = /** @type {HTMLSelectElement} */ (this.root.querySelector('#wicro-framework'));
    this.exampleSelect = /** @type {HTMLSelectElement} */ (this.root.querySelector('#wicro-example'));
    this.offlineToggle = /** @type {HTMLInputElement} */ (this.root.querySelector('#wicro-offline'));
    this.buildBtn = /** @type {HTMLButtonElement} */ (this.root.querySelector('#wicro-build'));
    this.flashBtn = /** @type {HTMLButtonElement} */ (this.root.querySelector('#wicro-flash'));
    this.monitorBtn = /** @type {HTMLButtonElement} */ (this.root.querySelector('#wicro-monitor-btn'));
    this.themeBtn = /** @type {HTMLButtonElement} */ (this.root.querySelector('#wicro-theme'));
    this.compatBanner = /** @type {HTMLElement} */ (this.root.querySelector('#wicro-compat-banner'));
    this.fileList = /** @type {HTMLUListElement} */ (this.root.querySelector('#wicro-file-list'));
    this.tabsBar = /** @type {HTMLElement} */ (this.root.querySelector('#wicro-tabs'));
    this.artifactsBox = /** @type {HTMLElement} */ (this.root.querySelector('#wicro-artifacts'));
    this.cacheBox = /** @type {HTMLElement} */ (this.root.querySelector('#wicro-cache-info'));
    this.outputLog = /** @type {HTMLElement} */ (this.root.querySelector('#wicro-output-log'));
    this.diagList = /** @type {HTMLUListElement} */ (this.root.querySelector('#wicro-diag-list'));
    this.diagCount = /** @type {HTMLElement} */ (this.root.querySelector('#wicro-diag-count'));
    this.serialLog = /** @type {HTMLElement} */ (this.root.querySelector('#wicro-serial-log'));
    this.baudSelect = /** @type {HTMLSelectElement} */ (this.root.querySelector('#wicro-baud'));
    this.statusDot = /** @type {HTMLElement} */ (this.root.querySelector('#wicro-status-dot'));
    this.statusText = /** @type {HTMLElement} */ (this.root.querySelector('#wicro-status-text'));
    this.progressTrack = /** @type {HTMLElement} */ (this.root.querySelector('#wicro-progress-track'));
    this.progressBar = /** @type {HTMLElement} */ (this.root.querySelector('#wicro-progress-bar'));
    this.statusBoard = /** @type {HTMLElement} */ (this.root.querySelector('#wicro-status-board'));
    this.statusMem = /** @type {HTMLElement} */ (this.root.querySelector('#wicro-status-mem'));
    this.statusDevice = /** @type {HTMLElement} */ (this.root.querySelector('#wicro-status-device'));

    if (this.actions.capabilities.warnings.length > 0) {
      this.compatBanner.hidden = false;
      this.compatBanner.textContent = this.actions.capabilities.warnings.join(' ');
    }

    const splitterV = /** @type {HTMLElement} */ (this.root.querySelector('#wicro-splitter-v'));
    const splitterH = /** @type {HTMLElement} */ (this.root.querySelector('#wicro-splitter-h'));
    attachSplitter(splitterV, this.root, '--sidebar-width', 'horizontal', 180, 420);
    attachSplitter(splitterH, this.root, '--dock-height', 'vertical', 140, 520);

    const body = this.root.querySelector('.ide-body');
    const panel = document.createElement('aside');
    panel.id = 'wicro-platform-configuration';
    panel.className = 'platform-configuration';
    panel.setAttribute('aria-label', 'Platform configuration');
    body?.appendChild(panel);
    const libraryPanel = document.createElement('aside');
    libraryPanel.id = 'wicro-library-panel';
    libraryPanel.className = 'platform-configuration library-panel';
    libraryPanel.setAttribute('aria-label', 'Library and package browser');
    libraryPanel.hidden = true;
    body?.appendChild(libraryPanel);
    this.root.querySelector('#wicro-libraries')?.addEventListener('click', () => {
      libraryPanel.hidden = !libraryPanel.hidden;
      if (!libraryPanel.hidden) { panel.hidden = true; this.root.querySelector('#wicro-configure')?.setAttribute('aria-expanded', 'false'); }
      this.root.querySelector('#wicro-libraries')?.setAttribute('aria-expanded', String(!libraryPanel.hidden));
    });
    this.root.querySelector('#wicro-configure')?.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) { libraryPanel.hidden = true; this.root.querySelector('#wicro-libraries')?.setAttribute('aria-expanded', 'false'); }
      this.root.querySelector('#wicro-configure')?.setAttribute('aria-expanded', String(!panel.hidden));
    });
    this.bindEvents();
    this.store.subscribe((changed) => this.sync(changed));
    this.sync('all');
  }

  renderShell() {
    this.root.className = 'wicro-ide';
    this.root.dataset.theme = this.store.theme;
    this.root.innerHTML = `
      <header class="ide-toolbar">
        <div class="toolbar-group toolbar-brand">
          <span class="brand-mark" aria-hidden="true">W</span>
          <strong class="brand-title">Wicro</strong>
          <span class="brand-badge">WASM IDE</span>
        </div>

        <div class="toolbar-group toolbar-selectors">
          <label class="field-label">
            <span>Board</span>
            <select id="wicro-board" aria-label="Board target"></select>
          </label>
          <label class="field-label">
            <span>Framework</span>
            <select id="wicro-framework" aria-label="Framework">
              <option value="arduino">Arduino</option>
              <option value="bare-metal">Bare-Metal</option>
              <option value="esp-idf">ESP-IDF</option>
            </select>
          </label>
          <label class="field-label">
            <span>Example</span>
            <select id="wicro-example" aria-label="Example project"></select>
          </label>
        </div>

        <div class="toolbar-group toolbar-actions">
          <label class="toggle-chip" title="Rebuild offline using cached OPFS toolchain and SDK">
            <input id="wicro-offline" type="checkbox" />
            <span>Offline</span>
          </label>
          <button id="wicro-libraries" type="button" class="btn btn-secondary" aria-controls="wicro-library-panel" aria-expanded="false">Libraries</button>
          <button id="wicro-configure" type="button" class="btn btn-secondary" aria-controls="wicro-platform-configuration" aria-expanded="true">Configure</button>
          <button id="wicro-build" type="button" class="btn btn-primary">Build</button>
          <button id="wicro-flash" type="button" class="btn btn-accent" disabled>Flash</button>
          <button id="wicro-monitor-btn" type="button" class="btn btn-secondary">Monitor</button>
          <button id="wicro-theme" type="button" class="btn btn-icon" title="Toggle light/dark theme" aria-label="Toggle theme">◐</button>
        </div>
      </header>

      <div id="wicro-compat-banner" class="compat-banner" hidden></div>

      <div class="ide-body">
        <aside class="ide-sidebar" aria-label="Project explorer">
          <div class="sidebar-section sidebar-files">
            <div class="section-header">
              <span>PROJECT FILES</span>
              <button id="wicro-add-file" type="button" class="btn-tiny" title="New file">+ File</button>
            </div>
            <ul id="wicro-file-list" class="file-list"></ul>
          </div>

          <div class="sidebar-section sidebar-artifacts">
            <div class="section-header">
              <span>BUILD ARTIFACTS</span>
            </div>
            <div id="wicro-artifacts" class="artifacts-box">
              <p class="muted">Build the project to generate firmware artifacts.</p>
            </div>
          </div>

          <div class="sidebar-section sidebar-cache">
            <div class="section-header">
              <span>WASM CACHE</span>
              <button id="wicro-clear-cache" type="button" class="btn-tiny" title="Clear cached toolchain and SDKs">Clear</button>
            </div>
            <div id="wicro-cache-info" class="cache-box"></div>
          </div>
        </aside>

        <div id="wicro-splitter-v" class="splitter splitter-v" role="separator" aria-orientation="vertical"></div>

        <div class="ide-main">
          <section class="editor-area">
            <div id="wicro-tabs" class="editor-tabs" role="tablist"></div>
            <div id="wicro-editor-container" class="editor-container"></div>
          </section>

          <div id="wicro-splitter-h" class="splitter splitter-h" role="separator" aria-orientation="horizontal"></div>

          <section class="dock-area" aria-label="Output and serial console">
            <div class="dock-header">
              <div class="dock-tabs" role="tablist">
                <button type="button" class="dock-tab active" data-tab="output">Compiler Output</button>
                <button type="button" class="dock-tab" data-tab="diagnostics">Problems <span id="wicro-diag-count" class="count-pill">0</span></button>
                <button type="button" class="dock-tab" data-tab="serial">Serial Monitor</button>
              </div>
              <div class="dock-controls" id="wicro-dock-controls-output">
                <button id="wicro-clear-output" type="button" class="btn-tiny">Clear</button>
              </div>
              <div class="dock-controls" id="wicro-dock-controls-serial" hidden>
                <select id="wicro-baud" class="select-tiny" aria-label="Baud rate">
                  <option value="9600">9600</option>
                  <option value="57600">57600</option>
                  <option value="115200" selected>115200</option>
                  <option value="230400">230400</option>
                  <option value="460800">460800</option>
                  <option value="921600">921600</option>
                </select>
                <label class="check-tiny"><input id="wicro-verify-flash" type="checkbox" checked /> Verify</label>
                <label class="check-tiny"><input id="wicro-auto-monitor" type="checkbox" checked /> Auto-monitor</label>
                <label class="check-tiny"><input id="wicro-serial-ts" type="checkbox" checked /> Time</label>
                <label class="check-tiny"><input id="wicro-serial-scroll" type="checkbox" checked /> Scroll</label>
                <button id="wicro-serial-pause" type="button" class="btn-tiny">Pause</button>
                <button id="wicro-serial-copy" type="button" class="btn-tiny">Copy</button>
                <button id="wicro-serial-clear" type="button" class="btn-tiny">Clear</button>
              </div>
            </div>

            <div class="dock-body">
              <div id="wicro-pane-output" class="dock-pane active">
                <pre id="wicro-output-log" class="terminal-log" aria-live="polite"></pre>
              </div>
              <div id="wicro-pane-diagnostics" class="dock-pane">
                <ul id="wicro-diag-list" class="diag-list"></ul>
              </div>
              <div id="wicro-pane-serial" class="dock-pane serial-pane">
                <pre id="wicro-serial-log" class="terminal-log" aria-live="polite"></pre>
                <form id="wicro-serial-form" class="serial-input-row">
                  <input id="wicro-serial-input" type="text" placeholder="Send to serial port…" autocomplete="off" />
                  <select id="wicro-line-ending" class="select-tiny" aria-label="Line ending">
                    <option value="\n" selected>LF (\n)</option>
                    <option value="\r\n">CRLF (\r\n)</option>
                    <option value="">None</option>
                  </select>
                  <button type="submit" class="btn-tiny">Send</button>
                </form>
              </div>
            </div>
          </section>
        </div>
      </div>

      <aside id="wicro-transfer" class="transfer-panel" hidden aria-label="Dependency download">
        <div class="transfer-heading"><strong id="wicro-transfer-name"></strong><span id="wicro-transfer-state" role="status"></span></div>
        <progress id="wicro-transfer-progress" max="100" aria-label="Download progress"></progress>
        <div class="transfer-details"><span id="wicro-transfer-detail"></span><div>
          <button id="wicro-transfer-pause" class="btn-tiny" type="button">Pause</button>
          <button id="wicro-transfer-cancel" class="btn-tiny" type="button">Cancel</button>
        </div></div>
      </aside>
      <footer class="ide-statusbar">
        <div class="status-left">
          <span id="wicro-status-dot" class="status-dot idle"></span>
          <span id="wicro-status-text">Ready</span>
          <div id="wicro-progress-track" class="progress-track" hidden>
            <div id="wicro-progress-bar" class="progress-bar"></div>
          </div>
        </div>
        <div class="status-right">
          <span id="wicro-status-board" class="status-pill">ESP32-C3 SuperMini</span>
          <span id="wicro-status-mem" class="status-pill" hidden></span>
          <span id="wicro-status-device" class="status-pill">USB: Disconnected</span>
        </div>
      </footer>
    `;
  }

  bindEvents() {
    this.boardSelect.addEventListener('change', () => this.actions.onSelectBoard(this.boardSelect.value));
    this.frameworkSelect.addEventListener('change', () => this.actions.onSelectFramework(this.frameworkSelect.value));
    this.exampleSelect.addEventListener('change', () => {
      if (this.exampleSelect.value) this.actions.onSelectExample(this.exampleSelect.value);
    });
    this.offlineToggle.addEventListener('change', () => {
      this.store.offline = this.offlineToggle.checked;
      this.store.emit('offline');
    });
    this.root.querySelector('#wicro-transfer-pause')?.addEventListener('click', () => this.actions.onTransferControl(this.store.download?.status === 'paused' ? 'resume' : 'pause'));
    this.root.querySelector('#wicro-transfer-cancel')?.addEventListener('click', () => this.actions.onTransferControl('cancel'));
    this.buildBtn.addEventListener('click', () => this.actions.onBuild({}));
    this.flashBtn.addEventListener('click', () => this.actions.onFlash());
    this.monitorBtn.addEventListener('click', () => this.actions.onToggleMonitor());
    this.themeBtn.addEventListener('click', () => {
      this.store.setTheme(this.store.theme === 'dark' ? 'light' : 'dark');
    });

    this.root.querySelector('#wicro-add-file')?.addEventListener('click', () => {
      const name = window.prompt('New file path (e.g., main/helper.h or main/helper.cpp):', 'main/helper.h');
      if (name && name.trim()) this.actions.onAddFile(name.trim());
    });

    this.root.querySelector('#wicro-clear-cache')?.addEventListener('click', () => this.actions.onClearCache());
    this.root.querySelector('#wicro-clear-output')?.addEventListener('click', () => this.store.clearCompilerLogs());

    for (const tabBtn of this.root.querySelectorAll('.dock-tab')) {
      tabBtn.addEventListener('click', () => {
        const tab = /** @type {'output'|'diagnostics'|'serial'} */ (/** @type {HTMLElement} */ (tabBtn).dataset.tab);
        this.setActiveBottomTab(tab);
      });
    }

    this.baudSelect.addEventListener('change', () => {
      this.store.updateUploadConfiguration({ monitorBaudRate: Number(this.baudSelect.value) || 115200 });
    });

    const verifyInput = /** @type {HTMLInputElement} */ (this.root.querySelector('#wicro-verify-flash'));
    verifyInput?.addEventListener('change', () => { this.store.updateUploadConfiguration({ verify: verifyInput.checked ? 'readback' : 'none' }); });

    const autoMonInput = /** @type {HTMLInputElement} */ (this.root.querySelector('#wicro-auto-monitor'));
    autoMonInput?.addEventListener('change', () => { this.store.updateUploadConfiguration({ autoMonitor: autoMonInput.checked }); });

    const tsInput = /** @type {HTMLInputElement} */ (this.root.querySelector('#wicro-serial-ts'));
    tsInput?.addEventListener('change', () => {
      this.store.serialTimestamps = tsInput.checked;
      this.renderSerial();
    });

    const scrollInput = /** @type {HTMLInputElement} */ (this.root.querySelector('#wicro-serial-scroll'));
    scrollInput?.addEventListener('change', () => { this.store.serialAutoScroll = scrollInput.checked; });

    const pauseBtn = /** @type {HTMLButtonElement} */ (this.root.querySelector('#wicro-serial-pause'));
    pauseBtn?.addEventListener('click', () => {
      this.store.serialPaused = !this.store.serialPaused;
      pauseBtn.textContent = this.store.serialPaused ? 'Resume' : 'Pause';
      if (!this.store.serialPaused) this.renderSerial();
    });

    this.root.querySelector('#wicro-serial-copy')?.addEventListener('click', async () => {
      const text = this.serialLog.textContent ?? '';
      try { await navigator.clipboard.writeText(text); } catch { /* Ignore clipboard denial. */ }
    });

    this.root.querySelector('#wicro-serial-clear')?.addEventListener('click', () => this.store.clearSerialLines());

    const serialForm = /** @type {HTMLFormElement} */ (this.root.querySelector('#wicro-serial-form'));
    const serialInput = /** @type {HTMLInputElement} */ (this.root.querySelector('#wicro-serial-input'));
    const lineEndingSelect = /** @type {HTMLSelectElement} */ (this.root.querySelector('#wicro-line-ending'));
    lineEndingSelect?.addEventListener('change', () => {
      this.store.lineEnding = /** @type {'\n'|'\r\n'|''} */ (lineEndingSelect.value);
    });
    serialForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!serialInput.value) return;
      this.actions.onSendSerial(serialInput.value);
      serialInput.value = '';
    });
  }

  /** @param {'output'|'diagnostics'|'serial'} tab */
  setActiveBottomTab(tab) {
    this.store.activeBottomTab = tab;
    for (const btn of this.root.querySelectorAll('.dock-tab')) {
      btn.classList.toggle('active', /** @type {HTMLElement} */ (btn).dataset.tab === tab);
    }
    for (const pane of this.root.querySelectorAll('.dock-pane')) {
      pane.classList.toggle('active', pane.id === `wicro-pane-${tab}`);
    }
    const outputControls = /** @type {HTMLElement} */ (this.root.querySelector('#wicro-dock-controls-output'));
    const serialControls = /** @type {HTMLElement} */ (this.root.querySelector('#wicro-dock-controls-serial'));
    if (outputControls) outputControls.hidden = tab !== 'output';
    if (serialControls) serialControls.hidden = tab !== 'serial';
  }

  /** @param {string} changed */
  sync(changed) {
    if (changed === 'configuration' || changed === 'file-content') changed = 'project';
    if (changed === 'all' || changed === 'theme') {
      this.root.dataset.theme = this.store.theme;
    }
    if (changed === 'all' || changed === 'boards') {
      this.boardSelect.innerHTML = '';
      for (const board of this.store.boards) {
        const opt = document.createElement('option');
        opt.value = board.id;
        const arch = board.metadata?.architecture ?? board.metadata?.build?.target ?? '';
        opt.textContent = `${board.id} (${arch})`;
        this.boardSelect.appendChild(opt);
      }
      this.boardSelect.value = this.store.boardId;
    }
    if (changed === 'all' || changed === 'examples') {
      this.exampleSelect.innerHTML = '';
      for (const example of this.store.examples) {
        const opt = document.createElement('option');
        opt.value = example.id;
        opt.textContent = example.id;
        this.exampleSelect.appendChild(opt);
      }
      this.exampleSelect.value = this.store.exampleId;
    }
    if (changed === 'all' || changed === 'board' || changed === 'framework' || changed === 'project') {
      this.boardSelect.value = this.store.boardId;
      this.frameworkSelect.replaceChildren();
      const frameworks = getTargetConfiguration(this.store.currentBoard).frameworks;
      for (const framework of new Set([...frameworks, this.store.framework])) {
        this.frameworkSelect.add(new Option(framework + (frameworks.includes(framework) ? '' : ' (unsupported)'), framework));
      }
      this.frameworkSelect.value = this.store.framework;
      this.exampleSelect.value = this.store.exampleId;
      if (![...this.baudSelect.options].some((option) => option.value === String(this.store.baudRate))) {
        this.baudSelect.add(new Option(String(this.store.baudRate), String(this.store.baudRate)));
      }
      this.baudSelect.value = String(this.store.baudRate);
      const verify = /** @type {HTMLInputElement} */ (this.root.querySelector('#wicro-verify-flash'));
      const autoMonitor = /** @type {HTMLInputElement} */ (this.root.querySelector('#wicro-auto-monitor'));
      verify.disabled = Boolean(this.store.configurationError);
      autoMonitor.disabled = Boolean(this.store.configurationError);
      this.baudSelect.disabled = Boolean(this.store.configurationError);
      verify.checked = this.store.verifyReadback;
      autoMonitor.checked = this.store.autoMonitorAfterFlash;
      const board = this.store.currentBoard;
      const arch = board?.metadata?.architecture ?? board?.metadata?.build?.target ?? '';
      this.statusBoard.textContent = board ? `${board.id} · ${arch} · ${this.store.framework}` : this.store.boardId;
    }
    if (changed === 'all' || changed === 'project' || changed === 'active-file') {
      this.renderFilesAndTabs();
    }
    if (changed === 'all' || changed === 'build' || changed === 'flash' || changed === 'board' || changed === 'project' || changed === 'device') {
      this.renderBuildAndFlashState();
    }
    if (changed === 'all' || changed === 'compiler-logs') {
      this.outputLog.textContent = this.store.compilerLogs.join('\n');
      this.outputLog.scrollTop = this.outputLog.scrollHeight;
    }
    if (changed === 'all' || changed === 'diagnostics' || changed === 'project') {
      this.renderDiagnostics();
    }
    if (changed === 'all' || changed === 'serial') {
      if (!this.store.serialPaused) this.renderSerial();
    }
    if (changed === 'all' || changed === 'device') {
      this.monitorBtn.textContent = this.store.deviceConnected ? 'Disconnect' : 'Monitor';
      this.statusDevice.textContent = `USB: ${this.store.deviceLabel}`;
      this.statusDevice.classList.toggle('connected', this.store.deviceConnected);
    }
    if (changed === 'all' || changed === 'download') this.renderTransfer();
    if (changed === 'all' || changed === 'cache') {
      this.renderCacheInfo();
    }
  }

  renderFilesAndTabs() {
    const paths = [...this.store.files.keys()].sort();
    this.fileList.innerHTML = '';
    this.tabsBar.innerHTML = '';

    for (const path of paths) {
      const li = document.createElement('li');
      li.className = `file-item${path === this.store.activeFile ? ' active' : ''}`;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'file-name';
      btn.textContent = path;
      btn.addEventListener('click', () => this.actions.onSelectFile(path));
      li.appendChild(btn);

      if (paths.length > 1 && path !== 'wicro.json') {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'file-delete';
        del.title = `Delete ${path}`;
        del.textContent = '×';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          this.actions.onDeleteFile(path);
        });
        li.appendChild(del);
      }
      this.fileList.appendChild(li);

      const tab = document.createElement('button');
      tab.type = 'button';
      tab.role = 'tab';
      tab.className = `editor-tab${path === this.store.activeFile ? ' active' : ''}`;
      tab.textContent = path.split('/').pop() ?? path;
      tab.title = path;
      tab.addEventListener('click', () => this.actions.onSelectFile(path));
      this.tabsBar.appendChild(tab);
    }
  }

  renderTransfer() {
    const download = this.store.download;
    const panel = /** @type {HTMLElement} */ (this.root.querySelector('#wicro-transfer'));
    panel.hidden = !download || ['complete', 'error', 'cancelled'].includes(download.status);
    if (!download || panel.hidden) return;
    (/** @type {HTMLElement} */ (this.root.querySelector('#wicro-transfer-name'))).textContent = download.name;
    (/** @type {HTMLElement} */ (this.root.querySelector('#wicro-transfer-state'))).textContent = download.status === 'paused' ? 'Paused' : download.status === 'restarting' ? 'Restarting — server cannot resume' : 'Downloading';
    const progress = /** @type {HTMLProgressElement} */ (this.root.querySelector('#wicro-transfer-progress'));
    if (download.total > 0) progress.value = download.received / download.total * 100;
    else progress.removeAttribute('value');
    const eta = download.etaSeconds;
    const detail = `${formatBytes(download.received)}${download.total ? ` / ${formatBytes(download.total)}` : ''} · ${formatBytes(download.bytesPerSecond ?? 0)}/s`;
    (/** @type {HTMLElement} */ (this.root.querySelector('#wicro-transfer-detail'))).textContent = download.status === 'paused' ? `${formatBytes(download.received)} received · ${download.resumable ? 'Resume available' : 'Resume will restart this file'}` : `${detail}${typeof eta === 'number' ? ` · about ${Math.ceil(eta)}s remaining` : ' · estimating time…'}`;
    (/** @type {HTMLElement} */ (this.root.querySelector('#wicro-transfer-pause'))).textContent = download.status === 'paused' ? 'Resume' : 'Pause';
  }

  renderBuildAndFlashState() {
    const target = getTargetConfiguration(this.store.currentBoard);
    const busy = this.store.buildStatus === 'building' || this.store.flashStatus === 'flashing';
    const invalid = this.store.configurationIssues.length > 0;
    this.boardSelect.disabled = busy || Boolean(this.store.configurationError);
    this.frameworkSelect.disabled = busy || Boolean(this.store.configurationError);
    this.exampleSelect.disabled = busy;
    this.buildBtn.disabled = busy || invalid;
    this.monitorBtn.disabled = !this.store.deviceConnected && (busy || invalid || ['picoboot', 'stlink-swd'].includes(target.protocol ?? '') || !this.actions.capabilities.webSerial);
    this.buildBtn.textContent = this.store.buildStatus === 'building' ? 'Building…' : 'Build';

    const hasBin = Boolean(this.store.lastBuild?.artifacts?.bin instanceof Uint8Array);
    this.flashBtn.disabled = busy || invalid || !hasBin || !(['dfuse', 'picoboot', 'stlink-swd'].includes(target.protocol ?? '') ? this.actions.capabilities.webUsb : this.actions.capabilities.webSerial) || !target.browserUpload || this.store.uploadSettings.programmer === 'none';
    this.flashBtn.textContent = this.store.flashStatus === 'flashing' ? 'Flashing…' : 'Flash';

    const activeProgress = this.store.flashStatus === 'flashing'
      ? this.store.flashProgress
      : this.store.buildProgress;

    this.statusText.textContent = activeProgress.message || 'Ready';
    this.statusDot.className = `status-dot ${this.store.flashStatus === 'flashing' ? 'building' : this.store.buildStatus}`;

    if (busy && typeof activeProgress.percent === 'number') {
      this.progressTrack.hidden = false;
      this.progressBar.style.width = `${Math.max(4, Math.min(100, activeProgress.percent))}%`;
    } else {
      this.progressTrack.hidden = true;
    }

    const last = this.store.lastBuild;
    if (last?.ok) {
      const mem = last.value?.memory;
      if (mem && (mem.totalFlashBytes > 0 || mem.totalRamBytes > 0)) {
        this.statusMem.hidden = false;
        this.statusMem.textContent = `Flash: ${formatBytes(mem.totalFlashBytes)} · RAM: ${formatBytes(mem.totalRamBytes)}`;
      } else {
        this.statusMem.hidden = true;
      }

      const rows = [];
      if (last.artifacts?.bin) {
        rows.push(`<button type="button" class="artifact-btn" data-dl="bin">firmware.bin <span>${formatBytes(last.artifacts.bin.byteLength)}</span></button>`);
      }
      if (last.artifacts?.elf) {
        rows.push(`<button type="button" class="artifact-btn" data-dl="elf">firmware.elf <span>${formatBytes(last.artifacts.elf.byteLength)}</span></button>`);
      }
      if (last.artifacts?.object) {
        rows.push(`<button type="button" class="artifact-btn" data-dl="object">main.o <span>${formatBytes(last.artifacts.object.byteLength)}</span></button>`);
      }
      const val = last.value?.validation;
      const valHtml = val
        ? `<div class="artifact-meta ${val.valid ? 'ok' : 'err'}">${val.valid ? '✓ Validated' : '✗ Invalid'} · ${val.segmentCount ?? 0} segs${val.sha256Valid ? ' · SHA-256 ✓' : ''}</div>`
        : '';
      const timeHtml = `<div class="artifact-meta">Time: ${(last.timingMs / 1000).toFixed(2)}s</div>`;
      this.artifactsBox.innerHTML = `${rows.join('')}${valHtml}${timeHtml}`;
      for (const btn of this.artifactsBox.querySelectorAll('.artifact-btn')) {
        btn.addEventListener('click', () => {
          const kind = /** @type {'bin'|'elf'|'object'} */ (/** @type {HTMLElement} */ (btn).dataset.dl);
          this.actions.onDownloadArtifact(kind);
        });
      }
    } else {
      this.statusMem.hidden = true;
      this.artifactsBox.innerHTML = '<p class="muted">Build the project to generate firmware artifacts.</p>';
    }
  }

  renderDiagnostics() {
    this.diagCount.textContent = String(this.store.diagnostics.length);
    this.diagList.innerHTML = '';
    if (this.store.diagnostics.length === 0) {
      const li = document.createElement('li');
      li.className = 'diag-empty';
      li.textContent = 'No compiler diagnostics.';
      this.diagList.appendChild(li);
      return;
    }

    for (const diag of this.store.diagnostics) {
      const li = document.createElement('li');
      li.className = `diag-item ${diag.severity}`;
      li.innerHTML = `
        <span class="diag-sev">${diag.severity.toUpperCase()}</span>
        <span class="diag-loc">${diag.file}:${diag.line}:${diag.column}</span>
        <span class="diag-msg"></span>
      `;
      const msg = li.querySelector('.diag-msg');
      if (msg) msg.textContent = diag.message;
      li.addEventListener('click', () => this.actions.onRevealDiagnostic(diag.file, diag.line, diag.column));
      this.diagList.appendChild(li);
    }
  }

  renderSerial() {
    const showTs = this.store.serialTimestamps;
    const text = this.store.serialLines.map((line) => {
      const prefix = showTs ? `[${formatTimestamp(line.timestamp)}] ` : '';
      const dir = line.direction === 'tx' ? '→ ' : line.direction === 'system' ? '• ' : '';
      return `${prefix}${dir}${line.text}`;
    }).join('\n');
    this.serialLog.textContent = text;
    if (this.store.serialAutoScroll) {
      this.serialLog.scrollTop = this.serialLog.scrollHeight;
    }
  }

  renderCacheInfo() {
    const info = this.store.cacheInfo;
    const sdks = info.cachedSdks?.length ? info.cachedSdks.join(', ') : 'None cached';
    this.cacheBox.innerHTML = `
      <div class="cache-row"><span>Storage</span><strong>${String(info.storage).toUpperCase()}</strong></div>
      <div class="cache-row"><span>LLVM WASM</span><strong>${info.compilerLoaded ? 'Loaded' : info.compilerCached ? 'Cached' : 'On demand'}</strong></div>
      <div class="cache-row"><span>SDKs</span><strong title="${sdks}">${sdks}</strong></div>
      <div class="cache-row"><span>Obj cache</span><strong>${info.incrementalObjects ?? 0}</strong></div>
    `;
  }
}
