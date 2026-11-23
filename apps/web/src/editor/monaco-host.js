import * as monaco from 'monaco-editor';

/**
 * Determine the Monaco language ID from a project file path.
 * @param {string} path
 */
const languageForPath = (path) => {
  if (/\.(ino|pde|cpp|cxx|cc|hpp|hh)$/i.test(path)) return 'cpp';
  if (/\.(c|h)$/i.test(path)) return 'c';
  if (/\.json$/i.test(path)) return 'json';
  return 'plaintext';
};

/**
 * Monaco editor host managing multi-file text models, compiler diagnostic markers,
 * theme switching, and navigation to diagnostic locations.
 */
export class MonacoEditorHost {
  /**
   * @param {HTMLElement} container
   * @param {{
   *   theme: 'dark'|'light',
   *   onChange: (path: string, value: string) => void
   * }} options
   */
  constructor(container, options) {
    this.onChange = options.onChange;
    /** @type {Map<string, monaco.editor.ITextModel>} */
    this.models = new Map();
    this.activePath = '';
    this.suppressChange = false;

    this.editor = monaco.editor.create(container, {
      value: '',
      language: 'cpp',
      theme: options.theme === 'light' ? 'vs' : 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: '"JetBrains Mono", "Fira Code", "SFMono-Regular", Consolas, monospace',
      fontSize: 13.5,
      lineHeight: 21,
      tabSize: 2,
      scrollBeyondLastLine: false,
      padding: { top: 12, bottom: 12 },
      renderLineHighlight: 'line'
    });

    this.editor.onDidChangeModelContent(() => {
      if (this.suppressChange || !this.activePath) return;
      this.onChange(this.activePath, this.editor.getValue());
    });
  }

  /**
   * Synchronize editor models with the project file map and show `activePath`.
   * @param {Map<string, string>} files
   * @param {string} activePath
   */
  syncFiles(files, activePath) {
    // Remove deleted models
    for (const [path, model] of this.models.entries()) {
      if (!files.has(path)) {
        model.dispose();
        this.models.delete(path);
      }
    }

    // Create or update models
    for (const [path, content] of files.entries()) {
      let model = this.models.get(path);
      if (!model) {
        const uri = monaco.Uri.parse(`file:///${path.replace(/^\/+/, '')}`);
        const existing = monaco.editor.getModel(uri);
        model = existing ?? monaco.editor.createModel(content, languageForPath(path), uri);
        if (existing && existing.getValue() !== content) {
          existing.setValue(content);
        }
        this.models.set(path, model);
      } else if (model.getValue() !== content) {
        this.suppressChange = true;
        model.setValue(content);
        this.suppressChange = false;
      }
    }

    this.openFile(activePath);
  }

  /** @param {string} path */
  openFile(path) {
    const model = this.models.get(path);
    if (!model) return;
    this.activePath = path;
    if (this.editor.getModel() !== model) {
      this.suppressChange = true;
      this.editor.setModel(model);
      this.suppressChange = false;
    }
  }

  /** @param {'dark'|'light'} theme */
  setTheme(theme) {
    monaco.editor.setTheme(theme === 'light' ? 'vs' : 'vs-dark');
  }

  /**
   * Apply compiler diagnostics across all open project file models.
   * @param {import('../state/ide-store.js').ParsedDiagnostic[]} diagnostics
   */
  setDiagnostics(diagnostics) {
    /** @type {Map<string, monaco.editor.IMarkerData[]>} */
    const byFile = new Map();
    for (const path of this.models.keys()) byFile.set(path, []);

    for (const diag of diagnostics) {
      const targetPath = this.models.has(diag.file)
        ? diag.file
        : [...this.models.keys()].find((p) => p.endsWith(`/${diag.file}`) || p === diag.file) ?? this.activePath;
      const list = byFile.get(targetPath);
      if (!list) continue;
      list.push({
        severity: diag.severity === 'error'
          ? monaco.MarkerSeverity.Error
          : diag.severity === 'warning'
            ? monaco.MarkerSeverity.Warning
            : monaco.MarkerSeverity.Info,
        message: diag.message,
        startLineNumber: Math.max(1, diag.line),
        startColumn: Math.max(1, diag.column),
        endLineNumber: Math.max(1, diag.line),
        endColumn: Math.max(1, diag.column + 1)
      });
    }

    for (const [path, markers] of byFile.entries()) {
      const model = this.models.get(path);
      if (model) monaco.editor.setModelMarkers(model, 'wicro', markers);
    }
  }

  /** @param {string} path @param {number} line @param {number} [column] */
  revealLocation(path, line, column = 1) {
    if (this.models.has(path)) this.openFile(path);
    this.editor.revealLineInCenter(Math.max(1, line));
    this.editor.setPosition({ lineNumber: Math.max(1, line), column: Math.max(1, column) });
    this.editor.focus();
  }

  dispose() {
    for (const model of this.models.values()) model.dispose();
    this.models.clear();
    this.editor.dispose();
  }
}
