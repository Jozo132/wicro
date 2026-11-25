import { loadProjectLibraries, validateLibraryCompileConfiguration } from './project-libraries.js';
import { applyFrameworkConfiguration } from './platform/framework-configuration.js';
export { applyFrameworkConfiguration } from './platform/framework-configuration.js';

import { inspectElfMemoryStats } from '../../runtime/src/elf-utils.js';
import { WicroPlatformRegistry } from './platform/registry.js';
import { createDefaultPlatformRegistry, BUILTIN_PROGRAMMERS } from './platform/defaults.js';
import { BUILTIN_ARCHITECTURES, resolveArchitectureTargetArgs } from './platform/architectures.js';
import { BUILTIN_FRAMEWORKS, arduinoFrameworkAdapter, bareMetalFrameworkAdapter, espIdfFrameworkAdapter } from './platform/frameworks.js';
import { BUILTIN_FIRMWARE_FORMATS, elfFormatHandler, flatBinFormatHandler, intelHexFormatHandler, uf2FormatHandler, esp32C3BinFormatHandler, esp8266RomFormatHandler } from './platform/formats.js';
import { ESP32_C3_ARDUINO_RECIPE, prepareEsp32C3LinkerScripts, esp32C3PlatformAdapter } from './platform/esp32.js';
import { esp8266BareMetalPlatformAdapter } from './platform/esp8266.js';
import { stm32BareMetalPlatformAdapter } from './platform/stm32.js';

export {
  WicroPlatformRegistry,
  createDefaultPlatformRegistry,
  BUILTIN_ARCHITECTURES,
  BUILTIN_FRAMEWORKS,
  BUILTIN_FIRMWARE_FORMATS,
  BUILTIN_PROGRAMMERS,
  resolveArchitectureTargetArgs,
  arduinoFrameworkAdapter,
  bareMetalFrameworkAdapter,
  espIdfFrameworkAdapter,
  elfFormatHandler,
  flatBinFormatHandler,
  intelHexFormatHandler,
  uf2FormatHandler,
  esp32C3BinFormatHandler,
  esp8266RomFormatHandler,
  esp8266BareMetalPlatformAdapter,
  ESP32_C3_ARDUINO_RECIPE,
  prepareEsp32C3LinkerScripts,
  esp32C3PlatformAdapter,
  stm32BareMetalPlatformAdapter
};

/** @typedef {'browser'|'node'|'vscode'} WicroHost */

/**
 * @typedef {object} WicroDiagnostic
 * @property {'error'|'warning'|'info'} severity
 * @property {string} message
 * @property {string} [source]
 * @property {string} [file]
 * @property {number} [line]
 * @property {number} [column]
 */

/**
 * @typedef {object} WicroResult
 * @property {boolean} ok
 * @property {unknown} [value]
 * @property {WicroDiagnostic[]} [diagnostics]
 */

/**
 * @typedef {object} WicroHostAdapter
 * @property {WicroHost} host
 * @property {(path: string, options?: {encoding?: 'utf8'|'binary'}) => Promise<string|Uint8Array>} readFile
 * @property {(path: string) => Promise<string[]>} [readdir]
 * @property {string} [cacheDirectory]
 * @property {import('../../registry/src/sdk.js').SdkStorage} [libraryStorage]
 * @property {import('../../registry/src/download.js').DownloadControl} [downloadControl]
 * @property {(event:import('../../registry/src/download.js').DownloadProgress)=>void} [downloadProgress]
 * @property {typeof fetch} [fetch]
 * @property {(url:string)=>Promise<string>} [resolveLibraryArtifact]
 * @property {boolean} [offline]
 * @property {string} [sdkCacheDirectory]
 * @property {(path: string, data: string|Uint8Array) => Promise<void>} writeFile
 */

/**
 * @typedef {object} WicroEngineOptions
 * @property {WicroHostAdapter} host
 * @property {import('../../registry/src/index.js').PackageRegistry} [registry]
 * @property {WicroPlatformRegistry} [platforms]
 * @property {any} [toolchain]
 * @property {string} [llvmPath]
 * @property {() => Promise<{llvmPath:string,linkerPath?:string}>} [resolveToolchain]
 * @property {(event: {stage:string,message:string,percent?:number}) => void} [onProgress]
 */

/**
 * Creates a host-independent Wicro engine.
 * @param {WicroEngineOptions} options
 */
export const createWicroEngine = (options) => {
  if (!options.host) throw new Error('A host adapter is required');

  const platforms = options.platforms ?? createDefaultPlatformRegistry();
  let toolchain = options.toolchain;
  /** @returns {Promise<any>} */
  const ensureToolchain = async () => {
    if (toolchain) return toolchain;
    if (options.resolveToolchain) {
      const resolved = await options.resolveToolchain();
      const { LlvmWasmToolchain } = await import('../../runtime/src/index.js');
      toolchain = new LlvmWasmToolchain({ llvmPath: resolved.llvmPath, linkerPath: resolved.linkerPath });
      return toolchain;
    }
    if (options.llvmPath) {
      const { LlvmWasmToolchain } = await import('../../runtime/src/index.js');
      toolchain = new LlvmWasmToolchain({ llvmPath: options.llvmPath });
      return toolchain;
    }
    throw new Error('LLVM WASM toolchain asset is not installed. Configure an external compiler distribution or local source and retry.');
  };

  return Object.freeze({
    host: options.host.host,
    platforms,

    /**
     * Execute a host-independent command.
     * @param {string|{command:'build',project:string,board?:string,formats?:string[]}|{command:'compile',source:string,board:string}|{command:'targets'}} command
     * @returns {Promise<WicroResult>}
     */
    async execute(command) {
      const resolvedToolchain = await ensureToolchain();
      toolchain = resolvedToolchain;
      if (typeof command === 'string') {
        if (command === 'targets') {
          try {
            const targets = await toolchain.targets();
            return { ok: true, value: targets };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, diagnostics: [{ severity: 'error', message }] };
          }
        }
        if (command.trim().length === 0) {
          return {
            ok: false,
            diagnostics: [{ severity: 'error', message: 'A command name is required' }]
          };
        }
        return {
          ok: false,
          diagnostics: [{ severity: 'info', message: `Command '${command}' is not implemented yet` }]
        };
      }

      if (command.command === 'targets') {
        return this.execute('targets');
      }

      if (command.command === 'compile') {
        const board = await loadBoardManifest(options.host, command.board);
        const build = asBuildManifest(board.metadata?.build);
        if (!build) {
          return { ok: false, diagnostics: [{ severity: 'error', message: `Board '${command.board}' has no compilation recipe` }] };
        }
        try {
          const result = await toolchain.compileC(command.source, build.target, build.targetOptions);
          return { ok: true, value: result, diagnostics: result.diagnostics.map((/** @type {string} */ message) => ({ severity: /** @type {'warning'} */ ('warning'), message })) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, diagnostics: [{ severity: 'error', message }] };
        }
      }

      if (command.command === 'build') {
        try {
          const result = await buildProject(options.host, toolchain, platforms, command.project, command.board, command.formats, options.onProgress);
          return { ok: true, value: result, diagnostics: result.diagnostics.map((/** @type {string} */ message) => ({ severity: /** @type {'warning'} */ ('warning'), message })) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, diagnostics: [{ severity: 'error', message }] };
        }
      }

      return { ok: false, diagnostics: [{ severity: 'error', message: 'Unsupported Wicro command' }] };
    }
  });
};

/**
 * @param {WicroHostAdapter} host
 * @param {string} boardName
 * @returns {Promise<import('../../registry/src/index.js').WicroPackageManifest>}
 */
const loadBoardManifest = async (host, boardName) => {
  const candidates = [
    `registry/${boardName}/package.json`,
    `../../../registry/${boardName}/package.json`,
    `../../registry/${boardName}/package.json`
  ];

  let lastError;
  for (const candidate of candidates) {
    try {
      const value = await host.readFile(candidate, { encoding: 'utf8' });
      if (typeof value === 'string') return /** @type {import('../../registry/src/index.js').WicroPackageManifest} */ (JSON.parse(value));
    } catch (error) {
      lastError = error;
    }
  }

  if (host.readdir) {
    try {
      const registryRoots = ['registry', '../../../registry', '../../registry'];
      for (const registryRoot of registryRoots) {
        const names = await host.readdir(registryRoot);
        for (const name of names.sort()) {
          try {
            const value = await host.readFile(`${registryRoot}/${name}/package.json`, { encoding: 'utf8' });
            if (typeof value === 'string') {
              const manifest = /** @type {import('../../registry/src/index.js').WicroPackageManifest} */ (JSON.parse(value));
              if (manifest.name === boardName) return manifest;
            }
          } catch {
            // Continue searching for a matching manifest name.
          }
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error : lastError;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Board package not found: ${boardName}`);
};

/**
 * @param {WicroHostAdapter} host
 * @param {import('../../registry/src/index.js').WicroPackageManifest} boardManifest
 */
const loadSdkFiles = async (host, boardManifest) => {
  /** @type {Record<string,string|Uint8Array>} */
  const files = {};
  /** @type {string[]} */
  const includeDirs = [];
  /** @type {Record<string,Uint8Array>} */
  const archives = {};
  /** @type {Record<string,string>} */
  const linkerScripts = {};
  const readdir = host.readdir;

  /** @param {string} directory @param {string} relative */
  const walk = async (directory, relative) => {
    if (!readdir) return;
    let names;
    try {
      names = await readdir(directory);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const absolute = `${directory}/${name}`.replace(/\/+/g, '/');
      const relativePath = `${relative}/${name}`.replace(/^\//, '').replace(/\/+/g, '/');
      if (/\.a$/i.test(name)) {
        try {
          const binary = await host.readFile(absolute, { encoding: 'binary' });
          if (binary instanceof Uint8Array) archives[`sdk/lib/${name}`] = binary;
        } catch {
          // Archive remains missing and the firmware linker fails closed.
        }
        continue;
      }
      if (!/\.(h|hpp|inc|ld|lds)$/i.test(name)) continue;
      try {
        const value = await host.readFile(absolute, { encoding: 'utf8' });
        if (typeof value === 'string') {
          const normalized = relativePath;
          const virtualPath = `sdk/${normalized}`.replace(/\/+/g, '/');
          files[virtualPath] = value;
          if (/\.(h|hpp|inc)$/i.test(name)) {
            includeDirs.push(virtualPath.slice(0, virtualPath.lastIndexOf('/')));
          }
          if (/\.(ld|lds)$/i.test(name)) {
            linkerScripts[`sdk/${name}`] = value;
          }
        }
      } catch {
        includeDirs.push(`sdk/${relativePath}`.replace(/\/+/g, '/'));
        await walk(absolute, relativePath);
      }
    }
  };

  for (const frameworkName of Object.keys(boardManifest.dependencies ?? {})) {
    let frameworkManifest;
    try {
      frameworkManifest = await loadBoardManifest(host, frameworkName);
    } catch {
      continue;
    }
    if (!host.cacheDirectory || !host.readdir) continue;

    const cacheRoot = `${host.cacheDirectory}/${frameworkName}-${frameworkManifest.version}`;
    /** @param {string} directory @param {string} relative */
    const frameworkWalk = async (directory, relative) => {
      if (!readdir) return;
      let names;
      try {
        names = await readdir(directory);
      } catch {
        return;
      }
      for (const name of names.sort()) {
        const absolute = `${directory}/${name}`.replace(/\/+/g, '/');
        const relativePath = `${relative}/${name}`.replace(/^\//, '').replace(/\/+/g, '/');
        if (/\.a$/i.test(name)) {
          try {
            const binary = await host.readFile(absolute, { encoding: 'binary' });
            if (binary instanceof Uint8Array) archives[`sdk/lib/${name}`] = binary;
          } catch {
            // The archive will remain missing and the firmware linker will fail closed.
          }
          continue;
        }
        if (!/\.(h|hpp|inc|ld|lds)$/i.test(name)) continue;
        try {
          const value = await host.readFile(absolute, { encoding: 'utf8' });
          if (typeof value === 'string') {
            const normalized = relativePath;
            const virtualPath = `sdk/${normalized}`.replace(/\/+/g, '/');
            files[virtualPath] = value;
            if (/\.(h|hpp|inc)$/i.test(name)) {
              includeDirs.push(virtualPath.slice(0, virtualPath.lastIndexOf('/')));
            }
            if (/\/Arduino\.h$|^sdk\/Arduino\.h$/i.test(virtualPath)) {
              includeDirs.push(virtualPath.slice(0, virtualPath.lastIndexOf('/')));
            }
            if (/\/pins_arduino\.h$/i.test(virtualPath)) {
              includeDirs.push(virtualPath.slice(0, virtualPath.lastIndexOf('/')));
            }
            if (/\.(ld|lds)$/i.test(name)) {
              linkerScripts[`sdk/${name}`] = value;
            }
          }
        } catch {
          includeDirs.push(`sdk/${relativePath}`.replace(/\/+/g, '/'));
          await walk(absolute, relativePath);
        }
      }
    };

    await frameworkWalk(cacheRoot, '');
  }

  if (host.sdkCacheDirectory) {
    await walk(host.sdkCacheDirectory, '');
  }

  return { files, includeDirs: [...new Set(includeDirs)], archives, linkerScripts };
};

/**
 * @typedef {object} BuildManifest
 * @property {'object'|'bare-metal'|'firmware'} kind
 * @property {string} target
 * @property {{march?:string,mabi?:string,mcpu?:string,mcu?:string}} [targetOptions]
 * @property {string} [source]
 * @property {string} [startupSource]
 * @property {string} [linkerScript]
 * @property {string} [output]
 */

/** @param {unknown} value @returns {BuildManifest|undefined} */
const asBuildManifest = (value) => {
  if (!value || typeof value !== 'object') return undefined;
  const build = /** @type {Record<string, unknown>} */ (value);
  if (typeof build.target !== 'string') return undefined;
  if (build.kind !== 'object' && build.kind !== 'bare-metal' && build.kind !== 'firmware') return undefined;

  const targetOptionsValue = build.targetOptions;
  const targetOptions = targetOptionsValue && typeof targetOptionsValue === 'object'
    ? /** @type {{march?:string,mabi?:string,mcpu?:string,mcu?:string}} */ (targetOptionsValue)
    : undefined;

  return /** @type {BuildManifest} */ ({
    kind: build.kind,
    target: build.target,
    targetOptions,
    source: typeof build.source === 'string' ? build.source : undefined,
    startupSource: typeof build.startupSource === 'string' ? build.startupSource : undefined,
    linkerScript: typeof build.linkerScript === 'string' ? build.linkerScript : undefined,
    output: typeof build.output === 'string' ? build.output : undefined,
    firmwareFormat: typeof build.firmwareFormat === 'string' ? build.firmwareFormat : undefined
  });
};

/**
 * @param {WicroHostAdapter} host
 * @param {LlvmWasmToolchain} toolchain
 * @param {string} project
 * @param {string} [boardName]
 */
const sourceExtension = /\.(ino|pde|cpp|cxx|cc|c|s|S|asm)$/;

/** @param {WicroHostAdapter} host @param {string} directory @param {Set<string>} [visited] */
const discoverSourceFiles = async (host, directory, visited = new Set()) => {
  if (!host.readdir) return [];
  if (visited.has(directory)) return [];
  visited.add(directory);

  /** @type {string[]} */
  const sources = [];
  let names;
  try {
    names = await host.readdir(directory);
  } catch {
    return [];
  }

  for (const name of names.sort()) {
    const path = `${directory}/${name}`.replace(/\/+/g, '/');
    try {
      const value = await host.readFile(path, { encoding: 'utf8' });
      if (typeof value === 'string' && sourceExtension.test(name)) sources.push(path);
    } catch {
      sources.push(...await discoverSourceFiles(host, path, visited));
    }
  }
  return sources;
};

/** @param {string} path */
const normalizeProjectSourcePath = (path) => {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`Unsafe project source path: ${path}`);
  }
  return normalized;
};

/**
 * @param {WicroHostAdapter} host
 * @param {any} toolchain
 * @param {WicroPlatformRegistry} platforms
 * @param {string} project
 * @param {string} [boardName]
 * @param {string[]} [requestedFormats]
 * @param {(event: {stage:string,message:string,percent?:number}) => void} [onProgress]
 */
const buildProject = async (host, toolchain, platforms, project, boardName, requestedFormats, onProgress) => {
  const startedAt = Date.now();
  onProgress?.({ stage: 'resolve', message: 'Resolving project and board configuration…', percent: 10 });
  // Phase 1: Resolve project manifest
  let board = boardName;
  /** @type {{board?:string,framework?:string,libraries?:import('../../registry/src/library-catalog.js').LibraryRequest[],build?:{sources?:string[],sourceDir?:string,flags?:string[],defines?:string[],formats?:string[]},sources?:string[],sourceDir?:string}} */
  let projectManifest = {};
  let manifestValue;
  try { manifestValue = await host.readFile(`${project}/wicro.json`, { encoding: 'utf8' }); }
  catch { /* Board may be supplied explicitly when no project manifest exists. */ }
  if (typeof manifestValue === 'string') {
    projectManifest = JSON.parse(manifestValue);
    if (!projectManifest || typeof projectManifest !== 'object' || Array.isArray(projectManifest)) throw new Error('wicro.json must contain a JSON object');
  }
  if (!board) board = projectManifest.board;
  if (!board) throw new Error('No board target was specified');

  // Phase 2: Resolve board, platform adapter, and framework adapter
  const originalBoardManifest = await loadBoardManifest(host, board);
  const boardManifest = applyFrameworkConfiguration(originalBoardManifest, typeof projectManifest.framework === 'string' ? projectManifest.framework : undefined);
  const build = asBuildManifest(boardManifest.metadata?.build);
  if (!build) throw new Error(`Board '${board}' has no compilation recipe`);

  const boardMetadata = /** @type {Record<string, unknown>} */ (boardManifest.metadata ?? {});
  const frameworkId = String(projectManifest.framework ?? boardMetadata.framework ?? (build.kind === 'bare-metal' ? 'bare-metal' : 'arduino'));
  /** @type {import('./platform/registry.js').BoardDescriptor} */
  const boardDescriptor = {
    id: board,
    name: boardManifest.name,
    mcu: String(boardMetadata.mcu ?? board),
    platform: typeof boardMetadata.platform === 'string' ? boardMetadata.platform : '',
    architecture: String(boardMetadata.architecture ?? build.target),
    framework: frameworkId,
    clockHz: typeof boardMetadata.clockHz === 'number' ? boardMetadata.clockHz : 16000000,
    build,
    metadata: boardMetadata,
    manifest: boardManifest
  };

  const platform = platforms.resolvePlatformForBoard(boardDescriptor);
  const linkerFn = toolchain.linkElf?.bind(toolchain) ?? toolchain.linkEsp32Elf?.bind(toolchain);
  if (build.kind === 'firmware' && !linkerFn) {
    throw new Error(`Board '${board}' firmware linking requires a WASM-native ELF linker`);
  }

  // Phase 3: Resolve SDK assets
  const sdk = await loadSdkFiles(host, boardManifest);

  // Phase 4: Discover and prepare sources via framework adapter
  const explicitSources = projectManifest.build?.sources ?? projectManifest.sources;
  /** @type {string[]} */
  let sourcePaths;
  if (explicitSources?.length) {
    sourcePaths = explicitSources.map(normalizeProjectSourcePath);
  } else {
    const sourceDir = projectManifest.build?.sourceDir ?? projectManifest.sourceDir;
    if (sourceDir) {
      sourcePaths = await discoverSourceFiles(host, `${project}/${normalizeProjectSourcePath(sourceDir)}`);
      sourcePaths = sourcePaths.map((path) => normalizeProjectSourcePath(path.slice(project.length + 1)));
    } else {
      sourcePaths = await discoverSourceFiles(host, `${project}/src`);
      sourcePaths = sourcePaths.map((path) => normalizeProjectSourcePath(path.slice(project.length + 1)));
      if (sourcePaths.length === 0) {
        const fallback = await discoverSourceFiles(host, project);
        sourcePaths = fallback
          .map((path) => normalizeProjectSourcePath(path.slice(project.length + 1)))
          .filter((path) => !path.startsWith('.wicro/'));
      }
    }
  }
  if (sourcePaths.length === 0 && build.source) {
    sourcePaths = [normalizeProjectSourcePath(build.source)];
  }
  if (sourcePaths.length === 0) throw new Error(`No source files found for project '${project}'`);

  /** @type {Record<string,string>} */
  const sourceFiles = {};
  for (const sourcePath of sourcePaths) {
    const sourceValue = await host.readFile(`${project}/${sourcePath}`, { encoding: 'utf8' });
    if (typeof sourceValue !== 'string') throw new Error(`Source file is not text: ${sourcePath}`);
    sourceFiles[sourcePath] = sourceValue;
  }

  const hasArduinoSources = sourcePaths.some((path) => /\.(ino|pde)$/i.test(path));
  const framework = platforms.getFramework(hasArduinoSources ? 'arduino' : frameworkId)
    ?? platforms.getFramework('arduino')
    ?? platforms.getFramework('bare-metal');
  if (!framework) throw new Error(`No registered framework adapter for '${frameworkId}'`);

  const prepared = framework.prepareSources({
    sourcePaths,
    sourceFiles,
    board: boardDescriptor,
    projectManifest
  });
  const frameworkLibraries = [];
  if (projectManifest.libraries?.length) {
    for (const provider of /** @type {string[]} */ (boardMetadata.libraryProviders ?? [])) {
      const providerManifest = await loadBoardManifest(host, provider);
      if (providerManifest.metadata?.library) frameworkLibraries.push(/** @type {import('../../registry/src/library-catalog.js').LibraryRelease} */ (providerManifest.metadata.library));
    }
  }
  const libraries = await loadProjectLibraries(host, project, projectManifest, boardDescriptor, frameworkLibraries);
  const { generatedCpp, sourceMap } = prepared;
  const units = [...prepared.units.map((unit) => ({ ...unit, includeDirs: /** @type {string[]} */ ([]), compilerFlags: /** @type {string[]} */ ([]) })), ...libraries.units];
  if (units.length === 0) throw new Error(`No compilable sources found for project '${project}'`);

  // Phase 5: Resolve platform compile configuration
  const compileConfig = platform
    ? await platform.resolveCompileConfig({ host, board: boardDescriptor, project, projectManifest, sdk, libraryFiles: libraries.files })
    : {
        compilerFlags: [...(projectManifest.build?.flags ?? [])],
        includeDirs: [...sdk.includeDirs],
        defines: [...framework.defaultDefines({ board: boardDescriptor, projectManifest }), ...(projectManifest.build?.defines ?? [])],
        preopens: undefined,
        files: sdk.files,
        extraUnits: []
      };

  validateLibraryCompileConfiguration(libraries, boardDescriptor.framework, compileConfig.defines);
  compileConfig.defines = [...new Set([...compileConfig.defines, ...libraries.globalDefines])];
  compileConfig.includeDirs = [...new Set([...compileConfig.includeDirs, ...libraries.includeDirs])];
  compileConfig.files = { ...(compileConfig.files ?? {}), ...libraries.files };

  /** @type {{path:string,object:Uint8Array,cache:string,diagnostics:string[]}[]} */
  const compiledObjects = [];
  /** @type {Record<string,Uint8Array>} */
  const linkObjects = {};
  /** @type {{elf?:Uint8Array,bin?:Uint8Array,object?:Uint8Array,target:string,diagnostics:string[],cache?:string}} */
  let result;
  /** @type {Record<string, string>} */
  const extraArtifacts = {};
  /** @type {import('./platform/registry.js').FirmwareValidationResult|undefined} */
  let firmwareValidation;

  // Phase 6: Compile & Link
  if (build.kind === 'bare-metal' && !linkerFn) {
    // Compatibility path for lightweight mock toolchains that only expose compileAndLinkBareMetal.
    if (!build.startupSource || !build.linkerScript) {
      throw new Error(`Board '${board}' has an incomplete bare-metal build recipe`);
    }
    const startupValue = await host.readFile(`${project}/${build.startupSource}`, { encoding: 'utf8' });
    const linkerValue = await host.readFile(`${project}/${build.linkerScript}`, { encoding: 'utf8' });
    if (typeof startupValue !== 'string' || typeof linkerValue !== 'string') {
      throw new Error(`Firmware sources for '${board}' must be text files`);
    }
    const primaryUnit = units[0];
    onProgress?.({ stage: 'compile', message: `Compiling ${primaryUnit.path}…`, percent: 40 });
    result = await toolchain.compileAndLinkBareMetal({
      source: primaryUnit.source,
      startupSource: startupValue,
      linkerScript: linkerValue,
      target: build.target,
      targetOptions: build.targetOptions,
      language: primaryUnit.language === 'c++' ? 'c++' : 'c'
    });
  } else {
    const totalCompileUnits = units.length + (compileConfig.extraUnits?.length ?? 0);
    let completedUnits = 0;
    for (let index = 0; index < units.length; index++) {
      const unit = units[index];
      onProgress?.({
        stage: 'compile',
        message: `Compiling ${unit.path} (${completedUnits + 1}/${totalCompileUnits})…`,
        percent: Math.round(20 + (completedUnits / Math.max(1, totalCompileUnits)) * 40)
      });
      const compiled = await toolchain.compileSource(unit.source, build.target, build.targetOptions, {
        language: unit.language,
        includeDirs: [...compileConfig.includeDirs, ...unit.includeDirs],
        compilerFlags: unit.language === 'c++' ? [...compileConfig.compilerFlags, ...unit.compilerFlags] : [...compileConfig.compilerFlags, ...unit.compilerFlags].filter((flag) => !flag.startsWith('-std=gnu++') && !flag.startsWith('-std=c++') && flag !== '-fno-rtti' && flag !== '-fno-exceptions'),
        preopens: compileConfig.preopens,
        files: compileConfig.files,
        defines: compileConfig.defines,
        cacheDirectory: `${project}/.wicro/cache`
      });
      completedUnits++;
      compiledObjects.push({ path: unit.path, object: compiled.object, cache: compiled.cache, diagnostics: compiled.diagnostics });
      const key = index === 0 ? 'main.o' : `user-${index}.o`;
      linkObjects[key] = compiled.object;
    }

    for (const extraUnit of compileConfig.extraUnits ?? []) {
      onProgress?.({
        stage: 'compile',
        message: `Compiling core unit ${extraUnit.name} (${completedUnits + 1}/${totalCompileUnits})…`,
        percent: Math.round(20 + (completedUnits / Math.max(1, totalCompileUnits)) * 40)
      });
      const compiled = await toolchain.compileSource(extraUnit.source, build.target, build.targetOptions, {
        language: extraUnit.language,
        includeDirs: [...compileConfig.includeDirs, ...(extraUnit.includeDirs ?? [])],
        compilerFlags: extraUnit.language === 'c++' ? compileConfig.compilerFlags : compileConfig.compilerFlags.filter((flag) => !flag.startsWith('-std=gnu++') && !flag.startsWith('-std=c++') && flag !== '-fno-rtti' && flag !== '-fno-exceptions'),
        preopens: compileConfig.preopens,
        files: compileConfig.files,
        defines: compileConfig.defines,
        cacheDirectory: `${project}/.wicro/cache`
      });
      completedUnits++;
      linkObjects[extraUnit.name] = compiled.object;
    }

    if (build.kind === 'firmware' || build.kind === 'bare-metal') {
      if (!platform) throw new Error(`No registered platform adapter for board '${board}' (${build.kind})`);
      if (!linkerFn) throw new Error(`Board '${board}' requires a WASM-native ELF linker`);

      onProgress?.({ stage: 'link', message: `Linking ${board} ELF firmware with WASM ld.lld…`, percent: 68 });
      const linkPlan = await platform.prepareLinkPlan({
        host,
        board: boardDescriptor,
        project,
        projectManifest,
        compiledObjects: linkObjects,
        sdk
      });

      const linked = await linkerFn({
        emitBinary: false,
        preObjects: linkPlan.preObjects,
        objects: linkPlan.objects,
        archives: linkPlan.archives,
        archivePaths: linkPlan.archivePaths,
        linkerScripts: linkPlan.linkerScripts,
        linkerScriptPaths: linkPlan.linkerScriptPaths,
        libraryPaths: linkPlan.libraryPaths,
        libraries: linkPlan.libraries,
        undefinedSymbols: linkPlan.undefinedSymbols,
        extraLinkerArgs: linkPlan.extraLinkerArgs,
        entry: linkPlan.entry,
        target: build.target,
        targetOptions: build.targetOptions,
        preopens: linkPlan.preopens
      });

      // Phase 7: Generate & validate firmware artifacts via registered FirmwareFormatHandler
      onProgress?.({ stage: 'image', message: 'Generating and validating firmware binary…', percent: 86 });
      const primaryFormatId = linkPlan.firmwareFormat ?? platform.defaultFirmwareFormat;
      const primaryHandler = platforms.getFirmwareFormat(primaryFormatId);
      const binBytes = (primaryHandler && linked.elf.length >= 52)
        ? await primaryHandler.convert(linked.elf, boardMetadata)
        : linked.bin;

      if (primaryHandler && binBytes.length > 24) {
        const validation = await primaryHandler.validate(binBytes, boardMetadata);
        firmwareValidation = validation;
        if (!validation.valid) {
          throw new Error(`Generated ${primaryFormatId} firmware image failed validation: ${validation.errors.join('; ')}`);
        }
      }

      const output = build.output ?? '.wicro/build';
      const formatsToEmit = [...new Set([...(requestedFormats ?? []), ...(projectManifest.build?.formats ?? [])])];
      for (const formatId of formatsToEmit) {
        const handler = platforms.getFirmwareFormat(formatId);
        if (!handler) throw new Error(`Unknown firmware format: ${formatId}`);
        if (linked.elf.length < 52) continue;
        const formatted = await handler.convert(linked.elf, boardMetadata);
        const check = await handler.validate(formatted, boardMetadata);
        if (!check.valid) throw new Error(`Generated ${formatId} artifact failed validation: ${check.errors.join('; ')}`);
        const artifactPath = `${project}/${output}/firmware${handler.extension}`;
        await host.writeFile(artifactPath, formatted);
        extraArtifacts[formatId] = artifactPath;
      }

      result = {
        elf: linked.elf,
        bin: binBytes,
        target: build.target,
        diagnostics: [...new Set([...compiledObjects.flatMap((item) => item.diagnostics), ...linked.diagnostics])]
      };
    } else {
      result = {
        object: compiledObjects[0]?.object ?? new Uint8Array(0),
        target: build.target,
        cache: compiledObjects[0]?.cache ?? 'miss',
        diagnostics: [...new Set(compiledObjects.flatMap((item) => item.diagnostics))]
      };
    }
  }

  // Phase 8: Write build outputs & compile_commands.json
  onProgress?.({ stage: 'write', message: 'Writing firmware artifacts…', percent: 95 });
  const output = build.output ?? '.wicro/build';
  if (generatedCpp) await host.writeFile(`${project}/${output}/sketch.cpp`, generatedCpp);
  for (const [objectIndex, compiled] of compiledObjects.entries()) {
    const objectName = compiled.path.split('/').pop()?.replace(/\.(ino|pde|c|cc|cpp|cxx|s|S|asm)$/i, '') ?? 'main';
    await host.writeFile(`${project}/${output}/${compiled.path.startsWith('libraries/') ? `library-${objectIndex}` : objectName}.o`, compiled.object);
  }
  if (compiledObjects.length > 0) {
    await host.writeFile(`${project}/${output}/main.o`, compiledObjects[0].object);
  }

  const compileCommands = units.map((unit) => ({
    directory: `${project}/${output}`,
    file: `${project}/${unit.path}`,
    arguments: [
      unit.language === 'c++' ? 'clang++' : 'clang',
      `--target=${build.target}`,
      ...[...compileConfig.includeDirs, ...unit.includeDirs].flatMap((directoryName) => ['-I', directoryName]),
      ...compileConfig.defines.flatMap((define) => ['-D', define]),
      ...compileConfig.compilerFlags,
      ...unit.compilerFlags,
      '-c', `${project}/${unit.path}`
    ]
  }));
  await host.writeFile(`${project}/${output}/compile_commands.json`, JSON.stringify(compileCommands, null, 2));

  if (result.elf && result.bin) {
    await host.writeFile(`${project}/${output}/firmware.elf`, result.elf);
    await host.writeFile(`${project}/${output}/firmware.bin`, result.bin);
  } else if (result.object) {
    await host.writeFile(`${project}/${output}/main.o`, result.object);
  }

  const memory = result.elf ? inspectElfMemoryStats(result.elf) : undefined;
  const timingMs = Date.now() - startedAt;
  onProgress?.({ stage: 'done', message: `Build completed in ${(timingMs / 1000).toFixed(2)}s`, percent: 100 });

  return {
    board,
    platform: platform?.id,
    framework: framework.id,
    output,
    kind: build.kind,
    target: build.target,
    elf: result.elf ? `${project}/${output}/firmware.elf` : undefined,
    bin: result.bin ? `${project}/${output}/firmware.bin` : undefined,
    elfBytes: result.elf?.byteLength,
    binBytes: result.bin?.byteLength,
    objectBytes: result.object?.byteLength,
    memory,
    validation: firmwareValidation,
    timingMs,
    artifacts: Object.keys(extraArtifacts).length > 0 ? extraArtifacts : undefined,
    object: result.object ? `${project}/${output}/main.o` : undefined,
    diagnostics: result.diagnostics,
    generatedCpp: generatedCpp ? `${project}/${output}/sketch.cpp` : undefined,
    sourceMap,
    sources: sourcePaths,
    libraries: libraries.libraries,
    compileCommands: `${project}/${output}/compile_commands.json`,
    objects: compiledObjects.map((item) => ({ path: item.path, cache: item.cache }))
  };
};
