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
  /** @type {Record<string,{name:string,properties:Record<string,string>,menus:Record<string,Record<string,string>>,menuProperties:Record<string,Record<string,Record<string,string>>>}>} */
  const boards = {};

  for (const [key, value] of Object.entries(properties)) {
    const match = key.match(/^([^./]+)\.name$/);
    if (match) {
      const id = match[1];
        boards[id] = { name: value, properties: {}, menus: {}, menuProperties: {} };
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
      if (parts.length === 4) {
        const menu = board.menus[menuId] ?? {};
        menu[optionId] = value;
        board.menus[menuId] = menu;
      } else {
        const menu = board.menuProperties[menuId] ?? {};
        const option = menu[optionId] ?? {};
        option[parts.slice(4).join('.')] = value;
        menu[optionId] = option;
        board.menuProperties[menuId] = menu;
      }
    } else if (parts[1]) {
      board.properties[parts.slice(1).join('.')] = value;
    }
  }

  return boards;
};

/**
 * Convert discovered STM32duino boards.txt entries into canonical Wicro board entries.
 * @param {Record<string,{name:string,properties:Record<string,string>,menus:Record<string,Record<string,string>>,menuProperties:Record<string,Record<string,Record<string,string>>>}>} boards
 * @param {{family?:string,sourceVersion?:string}} [options]
 */
export const discoverStm32Boards = (boards, options = {}) => {
  const discovered = [];
  for (const [boardId, board] of Object.entries(boards)) {
    const baseMcu = (board.properties['build.mcu'] ?? '').toUpperCase();
    const baseSeries = board.properties['build.series'] ?? board.properties['build.family'] ?? '';
    if (!/^STM32[A-Z0-9]/.test(baseMcu) && !/^STM32[A-Z0-9]/.test(baseSeries)) continue;
    const menuOptions = Object.entries(board.menus.pnum ?? {});
    const targets = menuOptions.length > 0 ? menuOptions : [['', '']];
    for (const [deviceOptionId, deviceLabel] of targets) {
      const optionProperties = deviceOptionId ? board.menuProperties.pnum?.[deviceOptionId] ?? {} : {};
      const properties = { ...board.properties, ...optionProperties };
      const mcu = (properties['build.mcu'] ?? baseMcu).toUpperCase();
      const series = properties['build.series'] ?? baseSeries;
      const flash = Number.parseInt(properties['upload.maximum_size'] ?? properties['build.maximum_size'] ?? '', 10);
      const ram = Number.parseInt(properties['build.maximum_ram_size'] ?? properties['build.ram_size'] ?? '', 10);
      const clock = Number.parseInt(properties['build.f_cpu']?.replace(/[^0-9]/g, '') ?? '', 10);
      const variant = properties['build.variant'] ?? properties['build.variants'] ?? '';
      const startup = properties['build.startup'] ?? properties['build.startup_file'] ?? '';
      const linkedScript = properties['build.ldscript'] ?? properties['build.linker_script'] ?? '';
      const cpuSource = `${mcu} ${baseMcu} ${series}`;
      const target = mcu.match(/^STM32([A-Z]\d+[A-Z]?)/i)?.[1] ?? (deviceOptionId || 'cortex-m');
      const architecture = /m7|m4|f[234]|g[04]|h7/i.test(cpuSource) ? 'armv7e-m' : 'armv7-m';
      const cpu = /m7/i.test(cpuSource) ? 'cortex-m7' : /m4/i.test(cpuSource) ? 'cortex-m4' : 'cortex-m3';
      const baseId = `stm32-${boardId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const optionSuffix = deviceOptionId ? `-${deviceOptionId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '';
      const id = `${baseId}${optionSuffix}`;
      const seriesMatch = mcu.match(/^STM32(F[1-7]|G[0-4]|H7|L[0-5]|U5|WB|WL)/i)
        ?? baseSeries.toUpperCase().match(/^STM32(F[1-7]|G[0-4]|H7|L[0-5]|U5|WB|WL)/);
      const seriesCode = seriesMatch ? seriesMatch[1].toUpperCase() : 'STM32';
      const mcuSeries = deviceOptionId ? board.name : `STM32${seriesCode}`;
      const mcuDevice = deviceLabel || (/^STM32[A-Z0-9]+$/.test(mcu) ? mcu : 'Generic');
      const targetName = deviceLabel ? `${board.name} · ${deviceLabel}` : board.name;
      discovered.push({
        id,
        name: targetName,
        description: `${targetName} dynamically discovered from STM32duino boards.txt`,
        dependencies: { 'llvm-wasm': '^1.0.0', 'stm32-f4-arduino-sdk': '^1.0.0' },
        metadata: {
          manufacturer: 'STMicroelectronics',
          mcu: mcu || boardId,
          mcuType: 'STM32',
          mcuFamily: 'STM32',
          mcuSeries,
          mcuDevice,
          boardName: board.name,
          boardPreset: deviceOptionId ? `${boardId}:${deviceOptionId}` : boardId,
          package: properties['build.product_line'] ?? '',
          architecture,
          cpu,
          framework: 'arduino',
          status: 'discovered',
          dynamic: true,
          source: 'stm32duino-boards.txt',
          sourceVersion: options.sourceVersion,
          flashCapacityBytes: Number.isInteger(flash) && flash > 0 ? flash : undefined,
          sramCapacityBytes: Number.isInteger(ram) && ram > 0 ? ram : undefined,
          clockHz: Number.isInteger(clock) && clock > 0 ? clock : undefined,
          flashAddress: '0x08000000',
          sramAddress: /^H7/i.test(cpuSource) ? '0x24000000' : '0x20000000',
          boardId,
          boardTarget: target,
          programmerId: 'stm32-cdc-dfu',
          platform: 'st-stm32-bare-metal',
          frameworkConfigurations: {
            arduino: {
              dependencies: {
                'stm32-f4-arduino-sdk': '^1.0.0',
                'llvm-wasm': '^1.0.0'
              },
              metadata: {
                arduino: {
                  board: properties['build.board'] ?? boardId,
                  series: series || 'STM32F4xx',
                  productLine: properties['build.product_line'] ?? '',
                  variant,
                  startup: properties['build.startup_file'] ?? startup,
                  multilib: /fpu/i.test(mcu) ? 'v7e-m+fp/hard' : 'v7e-m/nofp'
                },
                build: { kind: 'firmware', source: 'main.ino', firmwareFormat: 'bin' }
              }
            }
          },
          build: {
            kind: 'firmware',
            target: architecture,
            targetOptions: { mcpu: cpu },
            source: 'main.ino',
            startupSource: startup || undefined,
            linkerScript: linkedScript || undefined,
            output: '.wicro/build'
          }
        }
      });
    }
  }
  return discovered.sort((left, right) => left.name.localeCompare(right.name));
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
