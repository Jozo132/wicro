import { LlvmWasmToolchain } from '../../runtime/src/index.js';
import { preprocessIno } from '../../arduino/src/index.js';

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
 * @property {string} [sdkCacheDirectory]
 * @property {(path: string, data: string|Uint8Array) => Promise<void>} writeFile
 */

/**
 * @typedef {object} WicroEngineOptions
 * @property {WicroHostAdapter} host
 * @property {import('../../registry/src/index.js').PackageRegistry} [registry]
 * @property {LlvmWasmToolchain} [toolchain]
 * @property {string} [llvmPath]
 * @property {() => Promise<{llvmPath:string,linkerPath?:string}>} [resolveToolchain]
 */

/**
 * Creates a host-independent Wicro engine.
 * @param {WicroEngineOptions} options
 */
export const createWicroEngine = (options) => {
  if (!options.host) throw new Error('A host adapter is required');

  let toolchain = options.toolchain;
  /** @returns {Promise<LlvmWasmToolchain>} */
  const ensureToolchain = async () => {
    if (toolchain) return toolchain;
    if (options.resolveToolchain) {
      const resolved = await options.resolveToolchain();
      toolchain = new LlvmWasmToolchain({ llvmPath: resolved.llvmPath, linkerPath: resolved.linkerPath });
      return toolchain;
    }
    if (options.llvmPath) {
      toolchain = new LlvmWasmToolchain({ llvmPath: options.llvmPath });
      return toolchain;
    }
    throw new Error('LLVM WASM toolchain asset is not installed. Configure an external compiler distribution or local source and retry.');
  };

  return Object.freeze({
    host: options.host.host,

    /**
     * Execute a host-independent command.
     * @param {string|{command:'build',project:string,board?:string}|{command:'compile',source:string,board:string}|{command:'targets'}} command
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
          const result = await buildProject(options.host, toolchain, command.project, command.board);
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
      try {
        const value = await host.readFile(absolute, { encoding: 'utf8' });
        if (typeof value === 'string') {
          const segments = relativePath.split('/');
          const normalized = segments.length > 1 ? segments.slice(1).join('/') : relativePath;
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
        try {
          const value = await host.readFile(absolute, { encoding: 'utf8' });
          if (typeof value === 'string') {
            const segments = relativePath.split('/');
            const normalized = segments.length > 1 ? segments.slice(1).join('/') : relativePath;
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
    output: typeof build.output === 'string' ? build.output : undefined
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

/** @param {WicroHostAdapter} host @param {LlvmWasmToolchain} toolchain @param {string} project @param {string} [boardName] */
const buildProject = async (host, toolchain, project, boardName) => {
  let board = boardName;
  /** @type {{board?:string,build?:{sources?:string[],sourceDir?:string,flags?:string[],defines?:string[]},sources?:string[],sourceDir?:string}}} */
  let projectManifest = {};
  try {
    const manifestValue = await host.readFile(`${project}/wicro.json`, { encoding: 'utf8' });
    if (typeof manifestValue === 'string') projectManifest = JSON.parse(manifestValue);
  } catch {
    // Board must be supplied explicitly or resolved from the project manifest.
  }
  if (!board) board = projectManifest.board;
  if (!board) throw new Error('No board target was specified');

  const boardManifest = await loadBoardManifest(host, board);
  const build = asBuildManifest(boardManifest.metadata?.build);
  if (!build) throw new Error(`Board '${board}' has no compilation recipe`);
  if (build.kind === 'firmware' && !toolchain.linkEsp32Elf) {
    throw new Error(`Board '${board}' firmware linking requires a WASM-native ESP32 ELF linker`);
  }

  const sdk = await loadSdkFiles(host, boardManifest);
  const boardMetadata = /** @type {{clockHz?:number}} */ (boardManifest.metadata ?? {});
  const boardDefine = board.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
  const defines = [
    `F_CPU=${typeof boardMetadata.clockHz === 'number' ? boardMetadata.clockHz : 16000000}L`,
    'ARDUINO=10808',
    `ARDUINO_${boardDefine}`,
    `ARDUINO_ARCH_${String(boardManifest.metadata?.architecture ?? '').replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`
  ].filter((value) => !value.endsWith('_'));

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

  const inoPaths = sourcePaths
    .filter((path) => /\.(ino|pde)$/i.test(path))
    .sort((left, right) => {
      const leftMain = /(?:^|\/)(?:main|sketch)\.(?:ino|pde)$/i.test(left);
      const rightMain = /(?:^|\/)(?:main|sketch)\.(?:ino|pde)$/i.test(right);
      if (leftMain !== rightMain) return leftMain ? -1 : 1;
      const leftBase = left.split('/').pop() ?? left;
      const rightBase = right.split('/').pop() ?? right;
      if (leftBase.length !== rightBase.length) return leftBase.length - rightBase.length;
      return leftBase.localeCompare(rightBase);
    });

  let result;
  let generatedCpp;
  let sourceMap;
  /** @type {{path:string,object:Uint8Array,cache:string,diagnostics:string[]}[]} */
  const compiledObjects = [];
  if (inoPaths.length > 0) {
    const tabs = Object.fromEntries(inoPaths.map((path) => [path, sourceFiles[path] ?? '']));
    const sketch = preprocessIno(tabs);
    generatedCpp = sketch.cpp;
    sourceMap = sketch.sourceMap;

    if (build.kind === 'bare-metal') {
      if (!build.startupSource || !build.linkerScript) {
        throw new Error(`Board '${board}' has an incomplete bare-metal build recipe`);
      }
      const startupValue = await host.readFile(`${project}/${build.startupSource}`, { encoding: 'utf8' });
      const linkerValue = await host.readFile(`${project}/${build.linkerScript}`, { encoding: 'utf8' });
      if (typeof startupValue !== 'string' || typeof linkerValue !== 'string') {
        throw new Error(`Firmware sources for '${board}' must be text files`);
      }
      generatedCpp = `${generatedCpp}\nextern "C" int main(void) { setup(); for (;;) { loop(); } return 0; }\n`;
      result = await toolchain.compileAndLinkBareMetal({
        source: generatedCpp,
        startupSource: startupValue,
        linkerScript: linkerValue,
        target: build.target,
        targetOptions: build.targetOptions,
        language: 'c++'
      });
    } else if (build.kind === 'firmware') {
      if (!sdk.archives['sdk/lib/libFrameworkArduino.a']) {
        throw new Error(`ESP32-C3 firmware linking is missing sdk/lib/libFrameworkArduino.a in the staged target SDK`);
      }
      if (!sdk.linkerScripts['sdk/memory.ld'] || !sdk.linkerScripts['sdk/sections.ld']) {
        throw new Error(`ESP32-C3 firmware linking is missing memory.ld or sections.ld in the staged target SDK`);
      }
      const compiledApp = await toolchain.compileSource(generatedCpp, build.target, build.targetOptions, {
        language: 'c++',
        includeDirs: sdk.includeDirs,
        files: sdk.files,
        defines,
        cacheDirectory: `${project}/.wicro/cache`
      });
      result = await toolchain.linkEsp32Elf({
        objects: { 'main.o': compiledApp.object },
        archives: sdk.archives,
        linkerScripts: sdk.linkerScripts,
        undefinedSymbols: ['_Z5setupv', '_Z4loopv', 'app_main', 'start_app'],
        target: build.target,
        targetOptions: build.targetOptions
      });
    } else {
      result = await toolchain.compileSource(generatedCpp, build.target, build.targetOptions, {
        language: 'c++',
        includeDirs: sdk.includeDirs,
        files: sdk.files,
        defines,
        cacheDirectory: `${project}/.wicro/cache`
      });
      compiledObjects.push({ path: inoPaths[0] ?? 'sketch.cpp', object: result.object, cache: result.cache, diagnostics: result.diagnostics });

      for (const sourcePath of sourcePaths.filter((path) => !/\.(ino|pde)$/i.test(path))) {
        const source = sourceFiles[sourcePath];
        const language = /\.(cpp|cxx|cc)$/i.test(sourcePath) ? 'c++' : /\.(s|S|asm)$/i.test(sourcePath) ? 'assembly' : 'c';
        const compiled = await toolchain.compileSource(source, build.target, build.targetOptions, {
          language,
          includeDirs: sdk.includeDirs,
          files: sdk.files,
          defines,
          cacheDirectory: `${project}/.wicro/cache`
        });
        compiledObjects.push({ path: sourcePath, object: compiled.object, cache: compiled.cache, diagnostics: compiled.diagnostics });
      }
    }
  } else if (build.kind === 'bare-metal') {
    if (!build.startupSource || !build.linkerScript) {
      throw new Error(`Board '${board}' has an incomplete bare-metal build recipe`);
    }
    const startupValue = await host.readFile(`${project}/${build.startupSource}`, { encoding: 'utf8' });
    const linkerValue = await host.readFile(`${project}/${build.linkerScript}`, { encoding: 'utf8' });
    const primarySource = sourcePaths.find((path) => /\.(cpp|cxx|cc|c)$/i.test(path));
    const sourceValue = primarySource ? sourceFiles[primarySource] : undefined;
    if (typeof sourceValue !== 'string' || typeof startupValue !== 'string' || typeof linkerValue !== 'string') {
      throw new Error(`Firmware sources for '${board}' must be text files`);
    }
    result = await toolchain.compileAndLinkBareMetal({
      source: sourceValue,
      startupSource: startupValue,
      linkerScript: linkerValue,
      target: build.target,
      targetOptions: build.targetOptions,
      language: /\.(cpp|cxx|cc)$/i.test(primarySource ?? '') ? 'c++' : 'c'
    });
  } else {
    const compilablePaths = sourcePaths.filter((path) => /\.(c|cpp|cxx|cc|s|S|asm)$/i.test(path));
    if (compilablePaths.length === 0) throw new Error(`No C, C++, or assembly sources found for project '${project}'`);

    for (const sourcePath of compilablePaths) {
      const language = /\.(cpp|cxx|cc)$/i.test(sourcePath) ? 'c++' : /\.(s|S|asm)$/i.test(sourcePath) ? 'assembly' : 'c';
      const compiled = await toolchain.compileSource(sourceFiles[sourcePath], build.target, build.targetOptions, {
        language,
        includeDirs: sdk.includeDirs,
        files: sdk.files,
        defines,
        cacheDirectory: `${project}/.wicro/cache`
      });
      compiledObjects.push({ path: sourcePath, object: compiled.object, cache: compiled.cache, diagnostics: compiled.diagnostics });
    }
    result = {
      object: compiledObjects[0]?.object ?? new Uint8Array(0),
      target: build.target,
      cache: compiledObjects[0]?.cache ?? 'miss',
      diagnostics: [...new Set(compiledObjects.flatMap((item) => item.diagnostics))]
    };
  }

  const output = build.output ?? '.wicro/build';
  if (generatedCpp) await host.writeFile(`${project}/${output}/sketch.cpp`, generatedCpp);
  for (const compiled of compiledObjects) {
    const objectName = compiled.path.split('/').pop()?.replace(/\.(ino|pde|c|cc|cpp|cxx|s|S|asm)$/i, '') ?? 'main';
    await host.writeFile(`${project}/${output}/${objectName}.o`, compiled.object);
  }
  if (compiledObjects.length > 0) {
    await host.writeFile(`${project}/${output}/main.o`, compiledObjects[0].object);
  }

  const compileCommands = sourcePaths
    .filter((path) => /\.(ino|pde|c|cc|cpp|cxx|s|S|asm)$/i.test(path))
    .map((path) => ({
      directory: `${project}/${output}`,
      file: `${project}/${path}`,
      arguments: [
        'clang++',
        `--target=${build.target}`,
        ...sdk.includeDirs.flatMap((directoryName) => ['-I', directoryName]),
        ...defines.flatMap((define) => ['-D', define]),
        '-c',
        `${project}/${path}`
      ]
    }));
  await host.writeFile(`${project}/${output}/compile_commands.json`, JSON.stringify(compileCommands, null, 2));

  if ('elf' in result && 'bin' in result) {
    await host.writeFile(`${project}/${output}/firmware.elf`, result.elf);
    await host.writeFile(`${project}/${output}/firmware.bin`, result.bin);
  } else {
    await host.writeFile(`${project}/${output}/main.o`, result.object);
  }

  return {
    board,
    output,
    kind: build.kind,
    target: build.target,
    elf: 'elf' in result ? `${project}/${output}/firmware.elf` : undefined,
    bin: 'bin' in result ? `${project}/${output}/firmware.bin` : undefined,
    object: 'object' in result ? `${project}/${output}/main.o` : undefined,
    diagnostics: result.diagnostics,
    generatedCpp: generatedCpp ? `${project}/${output}/sketch.cpp` : undefined,
    sourceMap,
    sources: sourcePaths,
    compileCommands: `${project}/${output}/compile_commands.json`,
    objects: compiledObjects.map((item) => ({ path: item.path, cache: item.cache }))
  };
};
