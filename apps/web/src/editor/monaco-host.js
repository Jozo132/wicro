import * as monaco from 'monaco-editor';
import EditorWorker from '../../../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker';
import JsonWorker from '../../../../node_modules/monaco-editor/esm/vs/language/json/json.worker.js?worker';
import CssWorker from '../../../../node_modules/monaco-editor/esm/vs/language/css/css.worker.js?worker';
import HtmlWorker from '../../../../node_modules/monaco-editor/esm/vs/language/html/html.worker.js?worker';
import TsWorker from '../../../../node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js?worker';

/** @type {any} */ (globalThis).MonacoEnvironment = {
  getWorker(/** @type {string} */ _moduleId, /** @type {string} */ label) {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  }
};

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
   *   onChange: (path: string, value: string) => void,
   *   onComplete?: (path: string, line: number, column: number) => Promise<Array<{label:string,detail:string}>>
   * }} options
   */
  constructor(container, options) {
    this.onChange = options.onChange;
    this.onComplete = options.onComplete;
    /** @type {Map<string, monaco.editor.ITextModel>} */
    this.models = new Map();
    this.activePath = '';
    this.suppressChange = false;
    /** @type {monaco.IDisposable[]} */
    this.disposables = [];

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

    if (this.onComplete) {
      for (const lang of ['cpp', 'c']) {
        this.disposables.push(monaco.languages.registerCompletionItemProvider(lang, {
          triggerCharacters: ['.', '>', ':'],
          provideCompletionItems: async (model, position) => {
            if (!this.onComplete || !this.activePath) return { suggestions: [] };
            try {
              const items = await this.onComplete(this.activePath, position.lineNumber, position.column);
              const word = model.getWordUntilPosition(position);
              const range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn
              };
              return {
                suggestions: items.map((item) => ({
                  label: item.label,
                  insertText: item.label,
                  detail: item.detail,
                  kind: item.detail.includes('(')
                    ? monaco.languages.CompletionItemKind.Method
                    : monaco.languages.CompletionItemKind.Property,
                  range
                }))
              };
            } catch {
              return { suggestions: [] };
            }
          }
        }));
      }
    }
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
      const model = this.models.get(targetPath);
      if (!list) continue;

      const lineNumber = Math.max(1, diag.line);
      let startColumn = Math.max(1, diag.column);
      let endColumn = typeof diag.endColumn === 'number' && diag.endColumn > startColumn
        ? diag.endColumn
        : startColumn + 1;

      // Expand 1-char caret markers to cover the full identifier/method token at that position.
      if (model && endColumn <= startColumn + 1 && lineNumber <= model.getLineCount()) {
        const word = model.getWordAtPosition({ lineNumber, column: startColumn });
        if (word && word.endColumn > word.startColumn) {
          startColumn = word.startColumn;
          endColumn = word.endColumn;
        }
      }

      list.push({
        severity: diag.severity === 'error'
          ? monaco.MarkerSeverity.Error
          : diag.severity === 'warning'
            ? monaco.MarkerSeverity.Warning
            : monaco.MarkerSeverity.Info,
        message: diag.message,
        startLineNumber: lineNumber,
        startColumn,
        endLineNumber: lineNumber,
        endColumn
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
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables = [];
    for (const model of this.models.values()) model.dispose();
    this.models.clear();
    this.editor.dispose();
  }
}
