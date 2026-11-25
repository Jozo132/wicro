import { LibraryManager, inspectLibrary, assertNoPlatformIoHooks } from '../../registry/src/libraries.js';

/**
 * Load actual library sources into the compiler's virtual filesystem, shared by
 * Node, browser and VS Code hosts. Source and dependency locks remain project data.
 * @param {import('./index.js').WicroHostAdapter} host
 * @param {string} project
 * @param {Record<string,any>} manifest
 * @param {{id:string,mcu:string,architecture:string,framework:string}} board
 * @param {import('../../registry/src/library-catalog.js').LibraryRelease[]} frameworkLibraries
 */
export const loadProjectLibraries = async (host, project, manifest, board, frameworkLibraries) => {
  /** @type {Record<string,string>} */
  const hookFiles = {};
  try { const value = await host.readFile(`${project}/platformio.ini`, { encoding: 'utf8' }); if (typeof value === 'string') hookFiles['platformio.ini'] = value; } catch { /* No PlatformIO project file. */ }
  assertNoPlatformIoHooks(hookFiles, manifest);
  if (manifest.libraries !== undefined && !Array.isArray(manifest.libraries)) throw new Error('wicro.json libraries must be an array');
  if (!manifest.libraries?.length) return createLibraryCompilePlan([]);
  if (!host.libraryStorage) throw new Error('Third-party libraries require a persistent libraryStorage host adapter');
  let lockText;
  try { lockText = await host.readFile(`${project}/wicro-libraries.lock.json`, { encoding: 'utf8' }); } catch { /* First dependency resolution. */ }
  const lock = typeof lockText === 'string' ? JSON.parse(lockText) : null;
  const architecture = /^ESP32/i.test(board.mcu) ? 'esp32' : /^ESP8266/i.test(board.mcu) ? 'esp8266' : /^STM32/i.test(board.mcu) ? 'stm32' : /^RP2/i.test(board.mcu) ? 'rp2040' : board.architecture;
  const manager = new LibraryManager({ storage: host.libraryStorage, fetch: host.fetch, offline: host.offline, target: board.id, architecture, framework: board.framework, frameworkLibraries, resolveArtifactUrl: host.resolveLibraryArtifact });
  const installed = await manager.ensureProject(manifest.libraries, lock);
  await host.writeFile(`${project}/wicro-libraries.lock.json`, JSON.stringify(installed.lock, null, 2));
  return createLibraryCompilePlan(installed.installed);
};

/** @param {Array<{release:import('../../registry/src/library-catalog.js').LibraryRelease,files:Record<string,Uint8Array>}>} installed */
export const createLibraryCompilePlan = (installed) => {
  /** @type {Record<string,Uint8Array>} */
  const files = {};
  /** @type {Array<{path:string,source:string,language:'c'|'c++'|'assembly',includeDirs:string[],compilerFlags:string[]}>} */
  const units = [];
  /** @type {string[]} */
  const includeDirs = [];
  /** @type {string[]} */
  const globalDefines = [];
  /** @type {string[]} */
  const recipes = [];
  for (const entry of installed) {
    const prefix = `libraries/${entry.release.sha256}`;
    const metadata = inspectLibrary(entry.files, entry.release);
    globalDefines.push(...metadata.globalDefines);
    if (metadata.recipe) recipes.push(metadata.recipe);
    for (const [name, bytes] of Object.entries(entry.files)) files[`${prefix}/${name}`] = bytes;
    includeDirs.push(...metadata.includeRoots.map((root) => `${prefix}${root ? `/${root}` : ''}`));
    for (const path of metadata.sourceFiles) units.push({
      path: `${prefix}/${path}`, source: new TextDecoder().decode(entry.files[path]),
      language: /\.(cpp|cc|cxx)$/.test(path) ? 'c++' : /\.(s|S|asm)$/.test(path) ? 'assembly' : 'c',
      includeDirs: [`${prefix}/${path.split('/').slice(0, -1).join('/')}`.replace(/\/$/, '')],
      compilerFlags: metadata.flags
    });
  }
  return { files, units, globalDefines: [...new Set(globalDefines)], recipes, includeDirs: [...new Set(includeDirs)], libraries: installed.map(({ release }) => ({ id: release.id, name: release.name, version: release.version })) };
};

/** Reject an upstream empty firmware guard before any compilation.
 * @param {{recipes:string[]}} plan @param {string} framework @param {string[]} compilerDefines
 */
export const validateLibraryCompileConfiguration = (plan, framework, compilerDefines) => {
  if (!plan.recipes.includes('cdc-dfu-1.1.2')) return;
  const defines = new Set(compilerDefines.map((define) => define.split('=')[0]));
  if (framework !== 'arduino' || !['STM32F4xx', 'STM32H7xx'].some((define) => defines.has(define)) || !defines.has('USBCON') || !defines.has('USBD_USE_CDC')) throw new Error('cdc-dfu 1.1.2 requires an STM32F4/H7 Arduino USB CDC framework recipe; its firmware hook would otherwise compile empty');
};
