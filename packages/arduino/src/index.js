/** @typedef {object} ArduinoProperty @property {string} key @property {string} value */

/** @typedef {object} ArduinoInoResult
 * @property {string} cpp
 * @property {string[]} prototypes
 * @property {{generatedLine:number,source:string,sourceLine:number}[]} sourceMap
 */

/** @typedef {object} ArduinoLibrary @property {string} name @property {string} [version] @property {string[]} [architectures] @property {string[]} [includes] */

/** @typedef {object} ArduinoBoardPreset
 * @property {string} name
 * @property {string} mcu
 * @property {string} architecture
 * @property {string} framework
 * @property {number} [clockHz]
 * @property {number} [flashCapacityBytes]
 * @property {number} [sramCapacityBytes]
 * @property {Record<string,string|number|boolean>} [options]
 */

/** @param {string} text */
export const stripCComments = (text) => {
  let output = '';
  let inBlock = false;
  let inLine = false;
  let quote = '';

  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? '';
    const next = text[index + 1] ?? '';

    if (inLine) {
      if (char === '\n') {
        inLine = false;
        output += '\n';
      } else {
        output += ' ';
      }
      continue;
    }

    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false;
        output += '  ';
        index++;
      } else {
        output += char === '\n' ? '\n' : ' ';
      }
      continue;
    }

    if (quote) {
      output += char;
      if (char === '\\') {
        if (next) {
          output += next;
          index++;
        }
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      output += char;
    } else if (char === '/' && next === '/') {
      inLine = true;
      output += '  ';
      index++;
    } else if (char === '/' && next === '*') {
      inBlock = true;
      output += '  ';
      index++;
    } else {
      output += char;
    }
  }

  return output;
};

/** @param {string} text */
export const parsePropertyFile = (text) => {
  /** @type {Record<string,string>} */
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) result[key] = value;
  }
  return result;
};

/** @param {string} text */
export const parseBoardsTxt = (text) => {
  const properties = parsePropertyFile(text);
  /** @type {Record<string,{name:string,properties:Record<string,string>,menus:Record<string,Record<string,string>>}>} */
  const boards = {};

  for (const [key, value] of Object.entries(properties)) {
    const match = key.match(/^([^./]+)\.name$/);
    if (match) {
      const id = match[1];
      boards[id] = { name: value, properties: {}, menus: {} };
    }
  }

  for (const [key, value] of Object.entries(properties)) {
    const parts = key.split('.');
    const boardId = parts[0];
    const board = boardId ? boards[boardId] : undefined;
    if (!board) continue;

    if (parts[1] === 'menu' && parts[2] && parts[3]) {
      const menuId = parts[2];
      const optionId = parts[3];
      const menu = board.menus[menuId] ?? {};
      menu[optionId] = value;
      board.menus[menuId] = menu;
    } else if (parts[1]) {
      board.properties[parts.slice(1).join('.')] = value;
    }
  }

  return boards;
};

/** @param {string} text */
export const parseLibraryProperties = (text) => parsePropertyFile(text);

/** @param {string} text */
export const parseLibraryJson = (text) => {
  const value = /** @type {Record<string,unknown>} */ (JSON.parse(text));
  /** @type {ArduinoLibrary} */
  const library = {
    name: typeof value.name === 'string' ? value.name : 'unnamed',
    version: typeof value.version === 'string' ? value.version : undefined,
    architectures: Array.isArray(value.architectures) ? value.architectures.filter((item) => typeof item === 'string') : undefined,
    includes: typeof value.includes === 'string'
      ? [value.includes]
      : Array.isArray(value.includes)
        ? value.includes.filter((item) => typeof item === 'string')
        : undefined
  };
  return library;
};

/** @param {string} text */
export const parsePlatformIoIni = (text) => {
  /** @type {Record<string,Record<string,string>>} */
  const sections = {};
  let section = 'default';
  let lastKey = '';
  sections[section] = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^\s+/.test(rawLine) && lastKey && line && !line.startsWith('#') && !line.startsWith(';') && !/^[A-Za-z_][A-Za-z0-9_.-]*\s*=/.test(line)) {
      sections[section][lastKey] += `\n${line}`;
      continue;
    }
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1] ?? 'default';
      lastKey = '';
      sections[section] ??= {};
      continue;
    }
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) { sections[section][key] = value; lastKey = key; }
  }

  return sections;
};

/** @param {string} declaration */
const normalizePrototype = (declaration) => {
  return declaration
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .replace(/\)\s*$/, ')')
    .trim();
};

/** @param {Record<string,string>} tabs */
export const preprocessIno = (tabs) => {
  const entries = Object.entries(tabs).sort(([left], [right]) => {
    const leftMain = /(?:^|\/)(?:main|sketch)\.(?:ino|pde)$/i.test(left);
    const rightMain = /(?:^|\/)(?:main|sketch)\.(?:ino|pde)$/i.test(right);
    if (leftMain !== rightMain) return leftMain ? -1 : 1;
    const leftBase = left.split('/').pop() ?? left;
    const rightBase = right.split('/').pop() ?? right;
    if (leftBase.length !== rightBase.length) return leftBase.length - rightBase.length;
    return leftBase.localeCompare(rightBase);
  });
  if (entries.length === 0) throw new Error('At least one Arduino sketch tab is required');

  /** @type {string[]} */
  const prototypes = [];
  const discovered = new Set();
  const excludedNames = new Set(['setup', 'loop', 'if', 'for', 'while', 'switch', 'catch']);

  for (const [source, text] of entries) {
    const cleaned = stripCComments(text);
    for (const match of cleaned.matchAll(/(?:^|[;\n{}])\s*(?!#)(?:(?:template\s*<[^;{}]+>\s*)?)([A-Za-z_]\w*(?:\s+[*&])?(?:[A-Za-z_<>,:\[\]\s*&]*))\s+([A-Za-z_]\w*)\s*\(([^{};]*)\)\s*(?:const\s*)?(?:noexcept(?:\([^{};]*\))?\s*)?(?:->\s*[^{};]+?)?\s*\{/gm)) {
      const declaration = `${match[1]?.trim() ?? ''} ${match[2]?.trim() ?? ''}(${match[3]?.trim() ?? ''})`.trim();
      const name = match[2]?.trim() ?? '';
      if (!name || excludedNames.has(name) || discovered.has(declaration)) continue;
      discovered.add(declaration);
      prototypes.push(normalizePrototype(declaration) + ';');
    }
  }

  if (!prototypes.includes('void setup();')) prototypes.unshift('void setup();');
  if (!prototypes.includes('void loop();')) prototypes.unshift('void loop();');

  const cppLines = ['#include <Arduino.h>', ...prototypes, ''];
  /** @type {{generatedLine:number,source:string,sourceLine:number}[]} */
  const sourceMap = [];

  for (const [source, text] of entries) {
    const safeSource = source.replace(/\\/g, '/').replace(/"/g, '\\"');
    cppLines.push(`#line 1 "${safeSource}"`);
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      sourceMap.push({
        generatedLine: cppLines.length,
        source,
        sourceLine: index + 1
      });
      cppLines.push(lines[index] ?? '');
    }
  }

  return /** @type {ArduinoInoResult} */ ({ cpp: cppLines.join('\n') + '\n', prototypes, sourceMap });
};

/** @param {Record<string,string>} files @param {string[]} [includeNames] */
export const discoverArduinoLibraries = (files, includeNames = []) => {
  const libraries = [];
  for (const [path, text] of Object.entries(files)) {
    if (path.endsWith('/library.properties')) {
      const properties = parseLibraryProperties(text);
      libraries.push({
        name: properties.name ?? path.split('/').slice(-2, -1)[0] ?? 'unknown',
        version: properties.version,
        architectures: properties.architectures?.split(',').map((item) => item.trim()).filter(Boolean),
        includes: includeNames
      });
    } else if (path.endsWith('/library.json')) {
      libraries.push(parseLibraryJson(text));
    }
  }
  return libraries;
};

/** @param {Record<string,string>} files @param {string[]} [includeNames] */
export const findMissingHeaders = (files, includeNames = []) => {
  const headers = new Set();
  for (const [path, text] of Object.entries(files)) {
    for (const match of text.matchAll(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm)) {
      const header = match[1];
      if (header && !includeNames.includes(header)) headers.add(header);
    }
  }
  const known = new Set([...Object.keys(files).map((path) => path.split('/').pop() ?? ''), 'Arduino.h']);
  return [...headers].filter((header) => !known.has(header)).sort();
};

/** @param {Record<string,string>} files @param {string} outputDirectory */
export class ArduinoRegistry {
  /** @param {{host?:'browser'|'node'|'vscode',fetch?:typeof fetch,boardIndexUrl?:string,libraryIndexUrl?:string}} [options] */
  constructor(options = {}) {
    this.host = options.host ?? 'node';
    this.fetch = options.fetch ?? fetch;
    this.boardIndexUrl = options.boardIndexUrl ?? 'https://downloads.arduino.cc/packages/package_index.json';
    this.libraryIndexUrl = options.libraryIndexUrl ?? 'https://downloads.arduino.cc/libraries/library_index.json';
  }

  /** @param {string} url */
  async fetchIndex(url) {
    try {
      const response = await this.fetch(url, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`Arduino index download failed (${response.status}): ${url}`);
      return response.json();
    } catch (error) {
      if (this.host === 'browser') {
        throw new Error(`Arduino index access failed in a browser. Configure CORS or use a cached/offline index: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
  }

  async boardIndex() {
    return this.fetchIndex(this.boardIndexUrl);
  }

  async libraryIndex() {
    return this.fetchIndex(this.libraryIndexUrl);
  }

  /** @param {string} query @returns {Promise<{name:string,version:string,architectures:string[]}[]>} */
  async searchLibraries(query) {
    if (!query.trim()) throw new Error('An Arduino Library Manager search query is required');
    const value = await this.libraryIndex();
    const entries = Array.isArray(value?.libraries) ? value.libraries : [];
    const normalized = query.toLowerCase();
    return entries
      .filter((/** @type {any} */ entry) => `${entry?.name ?? ''} ${entry?.paragraph ?? ''} ${entry?.category ?? ''}`
        .toLowerCase()
        .includes(normalized))
      .map((/** @type {any} */ entry) => ({
        name: typeof entry.name === 'string' ? entry.name : 'unknown',
        version: typeof entry.version === 'string' ? entry.version : '0.0.0',
        architectures: Array.isArray(entry.architectures) ? entry.architectures.filter((/** @type {unknown} */ item) => typeof item === 'string') : ['*']
      }))
      .sort((/** @type {{name:string}} */ left, /** @type {{name:string}} */ right) => left.name.localeCompare(right.name));
  }
}

/** @param {Record<string,string>} files @param {string} outputDirectory */
export const createCompileCommands = (files, outputDirectory) => {
  return Object.entries(files).map(([file, text]) => ({
    directory: outputDirectory,
    file,
    arguments: ['clang++', '-x', 'c++', '-include', 'Arduino.h', '-c', file],
    sha256: undefined
  }));
};
