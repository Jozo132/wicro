/**
 * Reactive state store for the Wicro browser IDE.
 * Keeps UI components decoupled from build execution, editor instances, and device I/O.
 */

/**
 * @typedef {object} BoardCatalogEntry
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {Record<string, string>} dependencies
 * @property {Record<string, any>} metadata
 */

/**
 * @typedef {object} ExampleEntry
 * @property {string} id
 * @property {string} board
 * @property {string} name
 * @property {string} framework
 * @property {Record<string, string>} files
 */

/**
 * @typedef {object} ParsedDiagnostic
 * @property {'error'|'warning'|'info'} severity
 * @property {string} file
 * @property {number} line
 * @property {number} column
 * @property {string} message
 */

/**
 * @typedef {object} SerialLine
 * @property {string} text
 * @property {number} timestamp
 * @property {'rx'|'tx'|'system'} direction
 */

export class IdeStore {
  constructor() {
    /** @type {Set<(changed: string) => void>} */
    this.listeners = new Set();

    /** @type {BoardCatalogEntry[]} */
    this.boards = [];
    /** @type {ExampleEntry[]} */
    this.examples = [];

    this.boardId = 'esp32-c3-supermini';
    this.framework = 'arduino';
    this.exampleId = 'esp32-c3-supermini/blink';

    /** @type {Map<string, string>} */
    this.files = new Map();
    this.activeFile = 'main/main.ino';

    this.offline = false;
    this.verifyReadback = true;
    this.autoMonitorAfterFlash = true;
    this.theme = /** @type {'dark'|'light'} */ (
      (typeof localStorage !== 'undefined' && localStorage.getItem('wicro-theme') === 'light') ? 'light' : 'dark'
    );

    this.buildStatus = /** @type {'idle'|'building'|'success'|'error'} */ ('idle');
    this.buildProgress = { stage: 'idle', message: 'Ready', percent: 0 };
    /** @type {string[]} */
    this.compilerLogs = [];
    /** @type {ParsedDiagnostic[]} */
    this.diagnostics = [];
    /** @type {any} */
    this.lastBuild = null;

    this.flashStatus = /** @type {'idle'|'flashing'|'success'|'error'} */ ('idle');
    this.flashProgress = { stage: 'idle', message: '', percent: 0 };

    this.deviceConnected = false;
    this.deviceState = 'disconnected';
    this.deviceLabel = 'No device';
    this.baudRate = 115200;
    this.lineEnding = /** @type {'\n'|'\r\n'|''} */ ('\n');
    this.serialAutoScroll = true;
    this.serialPaused = false;
    this.serialTimestamps = true;
    /** @type {SerialLine[]} */
    this.serialLines = [];

    /** @type {any} */
    this.cacheInfo = {
      storage: 'opfs',
      compilerCached: false,
      compilerLoaded: false,
      cachedSdks: [],
      loadedSdks: [],
      incrementalObjects: 0
    };

    this.activeBottomTab = /** @type {'output'|'diagnostics'|'serial'} */ ('output');
  }

  /** @param {(changed: string) => void} listener */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** @param {string} changed */
  emit(changed) {
    for (const listener of this.listeners) listener(changed);
  }

  get currentBoard() {
    return this.boards.find((b) => b.id === this.boardId) ?? null;
  }

  /** @param {BoardCatalogEntry[]} boards */
  setBoards(boards) {
    this.boards = boards;
    if (boards.length > 0 && !boards.some((b) => b.id === this.boardId)) {
      this.boardId = boards[0].id;
    }
    this.emit('boards');
  }

  /** @param {ExampleEntry[]} examples */
  setExamples(examples) {
    this.examples = examples;
    this.emit('examples');
  }

  /** @param {string} boardId */
  setBoard(boardId) {
    this.boardId = boardId;
    const board = this.currentBoard;
    if (board?.metadata?.framework) {
      this.framework = String(board.metadata.framework);
    }
    if (board?.metadata?.monitorBaud) {
      this.baudRate = Number(board.metadata.monitorBaud) || 115200;
    }
    this.lastBuild = null;
    this.emit('board');
  }

  /** @param {string} framework */
  setFramework(framework) {
    this.framework = framework;
    this.emit('framework');
  }

  /** @param {ExampleEntry} example */
  loadExample(example) {
    this.exampleId = example.id;
    this.boardId = example.board;
    this.framework = example.framework;
    this.files.clear();
    for (const [path, content] of Object.entries(example.files)) {
      this.files.set(path, content);
    }
    const preferred = Object.keys(example.files).find((f) => /\.(ino|pde|c|cpp)$/i.test(f))
      ?? Object.keys(example.files)[0]
      ?? 'main/main.ino';
    this.activeFile = preferred;
    this.lastBuild = null;
    this.diagnostics = [];
    this.emit('project');
  }

  /** @param {string} path @param {string} content */
  setFileContent(path, content) {
    this.files.set(path, content);
    this.emit('file-content');
  }

  /** @param {string} path @param {string} [content] */
  addFile(path, content = '') {
    const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean || clean.includes('..')) throw new Error(`Invalid file path: ${path}`);
    this.files.set(clean, content);
    this.activeFile = clean;
    this.emit('project');
  }

  /** @param {string} path */
  deleteFile(path) {
    if (this.files.size <= 1) return;
    this.files.delete(path);
    if (this.activeFile === path) {
      this.activeFile = [...this.files.keys()][0] ?? '';
    }
    this.emit('project');
  }

  /** @param {string} path */
  setActiveFile(path) {
    if (!this.files.has(path)) return;
    this.activeFile = path;
    this.emit('active-file');
  }

  /** @returns {Record<string, string>} */
  snapshotFiles() {
    return Object.fromEntries(this.files.entries());
  }

  /** @param {string} line */
  appendCompilerLog(line) {
    this.compilerLogs.push(line);
    if (this.compilerLogs.length > 1000) this.compilerLogs.shift();
    this.emit('compiler-logs');
  }

  clearCompilerLogs() {
    this.compilerLogs = [];
    this.emit('compiler-logs');
  }

  /** @param {SerialLine} line */
  appendSerialLine(line) {
    this.serialLines.push(line);
    if (this.serialLines.length > 2000) this.serialLines.shift();
    this.emit('serial');
  }

  clearSerialLines() {
    this.serialLines = [];
    this.emit('serial');
  }

  /** @param {'dark'|'light'} theme */
  setTheme(theme) {
    this.theme = theme;
    try { localStorage.setItem('wicro-theme', theme); } catch { /* Ignore storage quota. */ }
    this.emit('theme');
  }
}
