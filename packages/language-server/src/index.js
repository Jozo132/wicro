/** @typedef {'c'|'c++'} WicroLanguage */

/**
 * @typedef {object} WicroLanguagePosition
 * @property {number} line
 * @property {number} character
 */

/**
 * @typedef {object} WicroLanguageRange
 * @property {WicroLanguagePosition} start
 * @property {WicroLanguagePosition} end
 */

/**
 * @typedef {object} WicroLanguageDiagnostic
 * @property {'error'|'warning'|'info'} severity
 * @property {WicroLanguageRange} range
 * @property {string} message
 * @property {string} [source]
 * @property {string} [code]
 */

/**
 * @typedef {object} WicroDocument
 * @property {string} uri
 * @property {string} languageId
 * @property {string} text
 * @property {number} version
 */

/**
 * @typedef {object} WicroLanguageConfiguration
 * @property {string} target
 * @property {{march?:string,mabi?:string,mcpu?:string,mcu?:string}} [targetOptions]
 * @property {string[]} [includeDirs]
 * @property {string[]} [defines]
 * @property {Record<string,string|Uint8Array>} [files]
 * @property {string} [clangFormatPath]
 * @property {string} [clangTidyPath]
 * @property {string[]} [clangTidyChecks]
 */

/**
 * @typedef {object} WicroSymbol
 * @property {string} name
 * @property {string} uri
 * @property {WicroLanguageRange} range
 * @property {string} kind
 * @property {string} declaration
 */

const keywordsC = ['if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'return', 'sizeof', 'struct', 'union', 'enum', 'typedef', 'const', 'static', 'volatile', 'void', 'int', 'char', 'float', 'double', 'unsigned', 'signed'];
const keywordsCpp = [...keywordsC, 'class', 'namespace', 'template', 'typename', 'public', 'private', 'protected', 'virtual', 'override', 'nullptr', 'auto'];

/** @param {WicroDocument} document @param {WicroLanguagePosition} position */
const positionOffset = (document, position) => {
  const lines = document.text.split(/\r?\n/);
  const line = Math.max(0, Math.min(lines.length - 1, position.line));
  const prefix = lines.slice(0, line).join('\n').length + (line > 0 ? 1 : 0);
  return prefix + Math.max(0, Math.min(lines[line]?.length ?? 0, position.character));
};

/** @param {WicroDocument} document @param {number} offset */
const offsetPosition = (document, offset) => {
  const clamped = Math.max(0, Math.min(document.text.length, offset));
  const before = document.text.slice(0, clamped);
  const lines = before.split(/\r?\n/);
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
};

/** @param {string} declaration */
const declarationKind = (declaration) => {
  if (/\([^;]*\)\s*(?:\{|$)/.test(declaration)) return 'Function';
  if (/\b(class|struct|enum|union)\b/.test(declaration)) return 'Type';
  return 'Variable';
};

export class WicroLanguageIndex {
  constructor() {
    /** @type {Map<string,WicroSymbol[]>} */
    this.symbols = new Map();
  }

  /** @param {WicroDocument} document */
  indexDocument(document) {
    const symbols = [];
    const lines = document.text.split(/\r?\n/);

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? '';
      const functionMatch = line.match(/(?:^|[;{}])\s*(?:[\w:<>,*&\s]+\s)?([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:\{|;|$)/);
      if (functionMatch && functionMatch[1]) {
        const name = functionMatch[1];
        const character = line.indexOf(name);
        symbols.push({
          name,
          uri: document.uri,
          range: { start: { line: index, character }, end: { line: index, character: character + name.length } },
          kind: 'Function',
          declaration: line.trim()
        });
      }

      const declarationMatch = line.match(/\b(?:uint(?:8|16|32|64)_t|int|char|float|double|bool|void|auto|[A-Z]\w*(?:\s*[*&])?)\s+([A-Za-z_]\w*)\s*(?:=|;|,)/);
      if (declarationMatch && declarationMatch[1]) {
        const name = declarationMatch[1];
        const character = line.indexOf(name);
        symbols.push({
          name,
          uri: document.uri,
          range: { start: { line: index, character }, end: { line: index, character: character + name.length } },
          kind: declarationKind(line),
          declaration: line.trim()
        });
      }
    }

    this.symbols.set(document.uri, symbols);
  }

  /** @param {string} uri */
  removeDocument(uri) {
    this.symbols.delete(uri);
  }

  /** @param {string} name */
  find(name) {
    return [...this.symbols.values()].flat().filter((symbol) => symbol.name === name);
  }
}

export class WicroLanguageService {
  /** @param {{toolchain:import('../../runtime/src/index.js').LlvmWasmToolchain,host:'node'|'browser'|'vscode',configuration?:WicroLanguageConfiguration}} options */
  constructor(options) {
    if (!options.toolchain) throw new Error('A WASM toolchain is required');
    this.toolchain = options.toolchain;
    this.host = options.host;
    this.configuration = options.configuration ?? { target: 'riscv32' };
    /** @type {Map<string,WicroDocument>} */
    this.documents = new Map();
    this.index = new WicroLanguageIndex();
  }

  /** @param {WicroDocument} document */
  openDocument(document) {
    this.documents.set(document.uri, document);
    this.index.indexDocument(document);
  }

  /** @param {string} uri @param {string} text @param {number} [version] */
  updateDocument(uri, text, version = 1) {
    const previous = this.documents.get(uri);
    if (!previous) throw new Error(`Document is not open: ${uri}`);
    const document = { ...previous, text, version };
    this.documents.set(uri, document);
    this.index.indexDocument(document);
    return document;
  }

  /** @param {string} uri */
  closeDocument(uri) {
    this.documents.delete(uri);
    this.index.removeDocument(uri);
  }

  /** @param {string} uri @returns {Promise<WicroLanguageDiagnostic[]>} */
  async diagnostics(uri) {
    const document = this.documents.get(uri);
    if (!document) throw new Error(`Document is not open: ${uri}`);
    const result = await this.toolchain.diagnoseSource({
      source: document.text,
      target: this.configuration.target,
      targetOptions: this.configuration.targetOptions,
      language: document.languageId === 'cpp' ? 'c++' : 'c',
      includeDirs: this.configuration.includeDirs,
      files: this.configuration.files,
      defines: this.configuration.defines,
      unsaved: Object.fromEntries([...this.documents].map(([documentUri, value]) => [documentUri.split('/').pop() ?? 'main.c', value.text]))
    });

    return result.diagnostics.map((diagnostic) => ({
      severity: /** @type {'error'|'warning'|'info'} */ (diagnostic.severity),
      range: {
        start: { line: Math.max(0, diagnostic.line - 1), character: Math.max(0, diagnostic.column - 1) },
        end: { line: Math.max(0, diagnostic.line - 1), character: Math.max(0, diagnostic.column) }
      },
      source: 'clang',
      message: diagnostic.message
    }));
  }

  /** @param {string} uri @param {WicroLanguagePosition} position @returns {Promise<Array<{label:string,detail:string,kind?:number}>>} */
  async completion(uri, position) {
    const document = this.documents.get(uri);
    if (!document) throw new Error(`Document is not open: ${uri}`);
    const result = await this.toolchain.completeSource({
      source: document.text,
      target: this.configuration.target,
      targetOptions: this.configuration.targetOptions,
      language: document.languageId === 'cpp' ? 'c++' : 'c',
      line: position.line + 1,
      column: position.character + 1,
      includeDirs: this.configuration.includeDirs,
      files: this.configuration.files,
      defines: this.configuration.defines
    });
    if (result.exitCode !== 0) throw new Error(result.stderr || `Clang completion exited with status ${result.exitCode}`);

    const candidates = result.candidates.map((candidate) => ({ label: candidate.label, detail: candidate.detail }));
    const prefix = wordBefore(document, position);
    const symbols = this.index.find(prefix).map((symbol) => ({ label: symbol.name, detail: `${symbol.kind}: ${symbol.declaration}` }));
    const keywords = (document.languageId === 'cpp' ? keywordsCpp : keywordsC).filter((keyword) => keyword.startsWith(prefix)).map((keyword) => ({ label: keyword, detail: 'keyword' }));
    return uniqueCompletions([...candidates, ...symbols, ...keywords]);
  }

  /** @param {string} uri @param {WicroLanguagePosition} position */
  hover(uri, position) {
    const document = this.documents.get(uri);
    if (!document) return null;
    const name = wordAt(document, position);
    const symbol = this.index.find(name)[0];
    if (!symbol) return null;
    return { contents: { kind: 'markdown', value: `**${symbol.kind}** \`${symbol.name}\`\n\n${symbol.declaration}` } };
  }

  /** @param {string} uri @param {WicroLanguagePosition} position */
  definition(uri, position) {
    const document = this.documents.get(uri);
    if (!document) return [];
    const name = wordAt(document, position);
    return this.index.find(name).map((symbol) => ({ uri: symbol.uri, range: symbol.range }));
  }

  /** @param {string} uri @param {WicroLanguagePosition} position */
  references(uri, position) {
    const document = this.documents.get(uri);
    if (!document) return [];
    const name = wordAt(document, position);
    const locations = [];

    for (const value of this.documents.values()) {
      const regex = new RegExp(`\\b${escapeRegex(name)}\\b`, 'g');
      for (const match of value.text.matchAll(regex)) {
        const start = offsetPosition(value, match.index ?? 0);
        locations.push({ uri: value.uri, range: { start, end: { line: start.line, character: start.character + name.length } } });
      }
    }
    return locations;
  }

  /** @param {string} uri @param {WicroLanguagePosition} position @param {string} newName */
  async rename(uri, position, newName) {
    if (!/^[_A-Za-z][_A-Za-z0-9]*$/.test(newName)) throw new Error('Invalid symbol name');
    const document = this.documents.get(uri);
    if (!document) throw new Error(`Document is not open: ${uri}`);
    const name = wordAt(document, position);
    const edits = [];

    for (const value of this.documents.values()) {
      const regex = new RegExp(`\\b${escapeRegex(name)}\\b`, 'g');
      const textEdits = [];
      for (const match of value.text.matchAll(regex)) {
        const start = offsetPosition(value, match.index ?? 0);
        textEdits.push({ range: { start, end: { line: start.line, character: start.character + name.length } }, newText: newName });
      }
      if (textEdits.length) edits.push({ uri: value.uri, edits: textEdits });
    }
    return { changes: Object.fromEntries(edits.map((change) => [change.uri, change.edits])) };
  }

  /** @param {string} uri @param {{tabSize?:number,insertSpaces?:boolean}} [options] */
  async format(uri, options = {}) {
    const document = this.documents.get(uri);
    if (!document) throw new Error(`Document is not open: ${uri}`);
    if (!this.configuration.clangFormatPath) {
      throw new Error('Clang-Format WASM entry point is unavailable in the installed toolchain');
    }
    const result = await this.toolchain.runLanguageTool({
      tool: 'clang-format',
      toolPath: this.configuration.clangFormatPath,
      source: document.text,
      language: document.languageId === 'cpp' ? 'c++' : 'c',
      arguments: ['-style=file', `--assume-filename=${document.uri}`]
    });
    if (result.exitCode !== 0) throw new Error(result.stderr || `Clang-Format exited with status ${result.exitCode}`);
    return [{ range: { start: { line: 0, character: 0 }, end: offsetPosition(document, document.text.length) }, newText: result.stdout }];
  }

  /** @param {string} uri */
  async lint(uri) {
    const document = this.documents.get(uri);
    if (!document) throw new Error(`Document is not open: ${uri}`);
    if (!this.configuration.clangTidyPath) {
      throw new Error('Clang-Tidy WASM entry point is unavailable in the installed toolchain');
    }
    return this.toolchain.runLanguageTool({
      tool: 'clang-tidy',
      toolPath: this.configuration.clangTidyPath,
      source: document.text,
      language: document.languageId === 'cpp' ? 'c++' : 'c',
      arguments: ['-checks=' + (this.configuration.clangTidyChecks ?? ['*']).join(',')]
    });
  }

  /** @param {{root:string,files:string[],directory:string,extraArguments?:string[]}} options */
  createCompileCommands(options) {
    const argumentsList = [
      'clang',
      ...toolchainArguments(this.configuration),
      ...this.configuration.defines ?? [],
      ...(options.extraArguments ?? [])
    ];
    return options.files.map((file) => ({ directory: options.directory, file, arguments: [...argumentsList, '-c', file] }));
  }
}

/** @param {WicroLanguageConfiguration} configuration */
const toolchainArguments = (configuration) => {
  const target = configuration.target;
  const targetOptions = configuration.targetOptions ?? {};
  if (target === 'avr') return ['--target=avr', `-mmcu=${targetOptions.mcu ?? 'atmega328p'}`];
  if (target === 'xtensa') return ['--target=xtensa-esp-elf', `-mcpu=${targetOptions.mcpu ?? 'esp32'}`];
  if (target === 'riscv32') return ['--target=riscv32-esp-elf', `-march=${targetOptions.march ?? 'rv32imc'}`, `-mabi=${targetOptions.mabi ?? 'ilp32'}`];
  if (target === 'riscv64') return ['--target=riscv64-unknown-elf', `-march=${targetOptions.march ?? 'rv64gc'}`, `-mabi=${targetOptions.mabi ?? 'lp64d'}`];
  if (target === 'armv6m') return ['--target=arm-none-eabi', `-mcpu=${targetOptions.mcpu ?? 'cortex-m0plus'}`, '-mthumb'];
  if (target === 'armv7-m') return ['--target=arm-none-eabi', `-mcpu=${targetOptions.mcpu ?? 'cortex-m3'}`, '-mthumb', '-mfloat-abi=soft'];
  if (target === 'armv7e-m') return ['--target=arm-none-eabi', `-mcpu=${targetOptions.mcpu ?? 'cortex-m4'}`, '-mthumb', '-mfloat-abi=hard'];
  return ['--target=arm-none-eabi', `-mcpu=${targetOptions.mcpu ?? 'cortex-m33'}`, '-mthumb', '-mfloat-abi=hard'];
};

/** @param {WicroDocument} document @param {WicroLanguagePosition} position */
const wordAt = (document, position) => {
  const line = document.text.split(/\r?\n/)[position.line] ?? '';
  const character = Math.max(0, Math.min(line.length, position.character));
  if (/\s/.test(line[character] ?? '') && character < line.length) {
    const next = [...line.matchAll(/[A-Za-z_]\w*/g)].find((match) => (match.index ?? 0) >= character);
    if (next) return next[0];
  }

  const left = line.slice(0, character).match(/[A-Za-z_]\w*$/)?.[0] ?? '';
  const right = line.slice(character).match(/^\w*/)?.[0] ?? '';
  if (/^[A-Za-z_]$/.test(line[character] ?? '') || (character === line.length && /^[A-Za-z_]$/.test(line[character - 1] ?? ''))) {
    if (left || right) return left + right;
  }

  let nearest = '';
  let nearestRight = '';
  let nearestRightDistance = Number.MAX_SAFE_INTEGER;
  let nearestDistance = Number.MAX_SAFE_INTEGER;
  for (const match of line.matchAll(/[A-Za-z_]\w*/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (character >= start && character <= end) return match[0];
    if (start >= character) {
      const distance = start - character;
      if (distance < nearestRightDistance) {
        nearestRightDistance = distance;
        nearestRight = match[0];
      }
    }
    const distance = character < start ? start - character : character - end;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = match[0];
    }
  }
  if (nearestRight) return nearestRight;
  return nearest;
};

/** @param {WicroDocument} document @param {WicroLanguagePosition} position */
const wordBefore = (document, position) => {
  const line = document.text.split(/\r?\n/)[position.line] ?? '';
  return line.slice(0, position.character).match(/[A-Za-z_]\w*$/)?.[0] ?? '';
};

/** @param {string} value */
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** @param {Array<{label:string,detail:string}>} items */
const uniqueCompletions = (items) => {
  const map = new Map();
  for (const item of items) if (!map.has(item.label)) map.set(item.label, item);
  return [...map.values()];
};

export { WicroLanguageWorkerProtocol } from './worker.js';

export class WicroLspSession {
  /** @param {WicroLanguageService} service */
  constructor(service) {
    this.service = service;
  }

  /** @param {{id?:string|number,jsonrpc?:string,method:string,params?:Record<string,any>}} message */
  async handle(message) {
    const id = message.id;
    const params = message.params ?? {};

    if (message.method === 'initialize') {
      return { jsonrpc: '2.0', id, result: { capabilities: {
        textDocumentSync: 1,
        completionProvider: { resolveProvider: false, triggerCharacters: ['.', '>'] },
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        renameProvider: true,
        documentFormattingProvider: true
      } } };
    }

    if (message.method === 'shutdown') return { jsonrpc: '2.0', id, result: null };

    if (message.method === 'textDocument/didOpen') {
      const textDocument = /** @type {{uri:string,languageId:string,version:number,text:string}} */ (params.textDocument);
      this.service.openDocument({ uri: textDocument.uri, languageId: textDocument.languageId, version: textDocument.version, text: textDocument.text });
      const diagnostics = await this.service.diagnostics(textDocument.uri);
      return { method: 'textDocument/publishDiagnostics', params: { uri: textDocument.uri, diagnostics } };
    }

    if (message.method === 'textDocument/didChange') {
      const textDocument = /** @type {{uri:string,version:number}} */ (params.textDocument);
      const change = /** @type {{text:string}} */ ((params.contentChanges?.[0]));
      this.service.updateDocument(textDocument.uri, change.text, textDocument.version);
      const diagnostics = await this.service.diagnostics(textDocument.uri);
      return { method: 'textDocument/publishDiagnostics', params: { uri: textDocument.uri, diagnostics } };
    }

    if (message.method === 'textDocument/didClose') {
      const textDocument = /** @type {{uri:string}} */ (params.textDocument);
      this.service.closeDocument(textDocument.uri);
      return { method: 'textDocument/publishDiagnostics', params: { uri: textDocument.uri, diagnostics: [] } };
    }

    if (message.method === 'textDocument/completion') {
      const textDocument = /** @type {{uri:string}} */ (params.textDocument);
      const position = /** @type {WicroLanguagePosition} */ (params.position);
      const items = await this.service.completion(textDocument.uri, position);
      return { jsonrpc: '2.0', id, result: { isIncomplete: false, items } };
    }

    if (message.method === 'textDocument/hover') {
      const textDocument = /** @type {{uri:string}} */ (params.textDocument);
      const position = /** @type {WicroLanguagePosition} */ (params.position);
      return { jsonrpc: '2.0', id, result: this.service.hover(textDocument.uri, position) };
    }

    if (message.method === 'textDocument/definition') {
      const textDocument = /** @type {{uri:string}} */ (params.textDocument);
      const position = /** @type {WicroLanguagePosition} */ (params.position);
      return { jsonrpc: '2.0', id, result: this.service.definition(textDocument.uri, position) };
    }

    if (message.method === 'textDocument/references') {
      const textDocument = /** @type {{uri:string}} */ (params.textDocument);
      const position = /** @type {WicroLanguagePosition} */ (params.position);
      return { jsonrpc: '2.0', id, result: this.service.references(textDocument.uri, position) };
    }

    if (message.method === 'textDocument/rename') {
      const textDocument = /** @type {{uri:string}} */ (params.textDocument);
      const position = /** @type {WicroLanguagePosition} */ (params.position);
      const newName = /** @type {string} */ (params.newName);
      return { jsonrpc: '2.0', id, result: await this.service.rename(textDocument.uri, position, newName) };
    }

    if (message.method === 'textDocument/formatting') {
      const textDocument = /** @type {{uri:string}} */ (params.textDocument);
      return { jsonrpc: '2.0', id, result: await this.service.format(textDocument.uri) };
    }

    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${message.method}` } };
  }
}
