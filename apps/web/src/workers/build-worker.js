import { createLibraryCompilePlan } from '../../../../packages/core/src/project-libraries.js';
import { LibraryCatalog } from '../../../../packages/registry/src/library-catalog.js';
import { LibraryManager, assertNoPlatformIoHooks } from '../../../../packages/registry/src/libraries.js';
import { unzipSync } from 'fflate';
import { createWicroEngine, createDefaultPlatformRegistry, ESP32_C3_ARDUINO_RECIPE } from '../../../../packages/core/src/index.js';
import { BrowserLlvmWasmToolchain, buildWasiDirectoryMap } from '../../../../packages/runtime/src/browser-toolchain.js';
import { parseClangDiagnostics } from '../../../../packages/runtime/src/elf-utils.js';
import { BrowserSdkStorage } from '../../../../packages/registry/src/browser-cache.js';
import { CompilerAssetManager } from '../../../../packages/registry/src/compiler-assets.js';
import { safeSdkArchivePath, sha256Bytes } from '../../../../packages/registry/src/sdk.js';
import { parseProjectConfiguration } from '../../../../packages/core/src/platform/configuration.js';
import { downloadBytes, DownloadControl } from '../../../../packages/registry/src/download.js';
import { preprocessIno } from '../../../../packages/arduino/src/index.js';

/**
 * In-memory fallback storage when OPFS is unavailable (e.g., restricted iframes).
 */
class MemoryAssetStorage {
  constructor() {
    /** @type {Map<string, Uint8Array>} */
    this.files = new Map();
  }
  /** @param {string} path */
  async exists(path) { return this.files.has(path.replace(/^\/+/, '')); }
  /** @param {string} path */
  async readText(path) { return new TextDecoder().decode(await this.readBytes(path)); }
  /** @param {string} path */
  async readBytes(path) {
    const data = this.files.get(path.replace(/^\/+/, ''));
    if (!data) throw new Error(`Memory cache miss: ${path}`);
    return data;
  }
  /** @param {string} path @param {string} text */
  async writeText(path, text) { this.files.set(path.replace(/^\/+/, ''), new TextEncoder().encode(text)); }
  /** @param {string} path @param {Uint8Array} data */
  async writeBytes(path, data) { this.files.set(path.replace(/^\/+/, ''), new Uint8Array(data)); }
  async mkdir() {}
  /** @param {string} path */
  async remove(path) {
    const prefix = path.replace(/^\/+/, '');
    for (const key of [...this.files.keys()]) {
      if (key === prefix || key.startsWith(`${prefix}/`)) this.files.delete(key);
    }
  }
  /** @param {string} path */
  async readdir(path) {
    const prefix = path.replace(/^\/+/, '').replace(/\/+$/, '');
    const names = new Set();
    for (const key of this.files.keys()) {
      const rest = prefix ? (key.startsWith(`${prefix}/`) ? key.slice(prefix.length + 1) : '') : key;
      if (rest) names.add(rest.split('/')[0]);
    }
    return [...names].sort();
  }
}

const platforms = createDefaultPlatformRegistry();
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/** @type {BrowserSdkStorage | MemoryAssetStorage | null} */
let storageInstance = null;
let storageBackend = 'opfs';

/** @returns {Promise<BrowserSdkStorage | MemoryAssetStorage>} */
const getStorage = async () => {
  if (storageInstance) return storageInstance;
  try {
    const opfs = new BrowserSdkStorage();
    await opfs.initialize();
    storageInstance = opfs;
    storageBackend = 'opfs';
  } catch {
    storageInstance = new MemoryAssetStorage();
    storageBackend = 'memory';
  }
  return storageInstance;
};

/** @type {WebAssembly.Module | null} */
let compiledLlvmModule = null;
/** @type {string} */
let compilerCacheState = 'not-installed';

/** @type {Map<string, any>} */
const registryManifestCache = new Map();

/**
 * Extracted SDKs in worker memory: sdkKey -> { files: Map<string, Uint8Array>, wasiDir: Map<string, any>, cache: string, version: string, sha256: string }
 * @type {Map<string, {files: Map<string, Uint8Array>, wasiDir: Map<string, any>, cache: string, version: string, sha256: string}>}
 */
const loadedSdks = new Map();

/** @type {Map<string, Uint8Array>} */
const incrementalObjectCache = new Map();

/** @type {Map<string,DownloadControl>} */
const downloadControls = new Map();
/** @param {string} id */
const transferOptions = (id) => ({ control: downloadControls.get(id), progress: (/** @type {import('../../../../packages/registry/src/download.js').DownloadProgress} */ transfer) => emitProgress(id, { stage: 'download', message: transfer.name, transfer }) });

/** @param {string} id @param {{stage:string,message:string,percent?:number,transfer?:import('../../../../packages/registry/src/download.js').DownloadProgress}} event */
const emitProgress = (id, event) => {
  self.postMessage({ type: 'progress', id, ...event });
};

/**
 * Fetch and cache a canonical registry manifest (with OPFS persistence for offline rebuilds).
 * @param {string} origin
 * @param {string} packageName
 * @param {boolean} [offline]
 */
const loadRegistryManifest = async (origin, packageName, offline = false) => {
  if (registryManifestCache.has(packageName)) return registryManifestCache.get(packageName);
  const storage = await getStorage();
  const cachePath = `registry/${packageName}/package.json`;

  if (offline && await storage.exists(cachePath)) {
    const parsed = JSON.parse(await storage.readText(cachePath));
    registryManifestCache.set(packageName, parsed);
    return parsed;
  }

  try {
    const response = await fetch(`${origin}/registry/${packageName}/package.json`, { cache: 'no-cache' });
    if (response.ok) {
      const text = await response.text();
      const parsed = JSON.parse(text);
      registryManifestCache.set(packageName, parsed);
      try { await storage.writeText(cachePath, text); } catch { /* Best-effort cache. */ }
      return parsed;
    }
  } catch {
    // Fall back to OPFS cache when offline.
  }

  if (await storage.exists(cachePath)) {
    const parsed = JSON.parse(await storage.readText(cachePath));
    registryManifestCache.set(packageName, parsed);
    return parsed;
  }

  throw new Error(`Registry package manifest not found: ${packageName}`);
};

/**
 * Ensure the shared LLVM WASM toolchain is downloaded, SHA-256 verified, cached in OPFS,
 * and compiled into a reusable WebAssembly.Module.
 * @param {string} origin
 * @param {string} requestId
 * @param {boolean} offline
 */
const ensureCompilerModule = async (origin, requestId, offline) => {
  if (compiledLlvmModule) return { module: compiledLlvmModule, cache: compilerCacheState };

  const storage = await getStorage();
  const manifest = await loadRegistryManifest(origin, 'llvm-wasm', offline);
  const localManifest = structuredClone(manifest);
  // The unified compiler includes ld.lld; the separate linker is unused here.
  delete localManifest.artifacts.ld;

  emitProgress(requestId, { stage: 'toolchain', message: 'Checking cached LLVM WASM toolchain…', percent: 4 });
  const manager = new CompilerAssetManager({
    storage,
    ...transferOptions(requestId)
  });

  const resolved = await manager.ensure(localManifest, { offline, localSources: import.meta.env.DEV ? { clang: `${origin}/toolchain/llvm.wasm` } : undefined });
  compilerCacheState = resolved.cache;

  emitProgress(requestId, { stage: 'toolchain', message: 'Compiling LLVM WebAssembly module…', percent: 26 });
  const bytes = await storage.readBytes(resolved.clang);
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  compiledLlvmModule = await WebAssembly.compile(copy);
  return { module: compiledLlvmModule, cache: compilerCacheState };
};

/**
 * Download, SHA-256 verify, persistently cache in OPFS, and extract a target SDK archive
 * into worker memory + reusable WASI PreopenDirectory map.
 * @param {string} origin
 * @param {string} requestId
 * @param {any} sdkManifest
 * @param {boolean} offline
 */
const ensureTargetSdk = async (origin, requestId, sdkManifest, offline) => {
  const sdkKey = `${sdkManifest.name}-${sdkManifest.version}`;
  const existing = loadedSdks.get(sdkKey);
  if (existing) return existing;

  const distribution = sdkManifest.metadata?.distribution;
  if (!distribution?.sha256 || distribution.sha256.length !== 64) {
    throw new Error(`SDK '${sdkManifest.name}' has no verified SHA-256 checksum`);
  }

  const storage = await getStorage();
  const archivePath = `sdks/${sdkKey}.zip`;
  const markerPath = `sdks/${sdkKey}.json`;
  /** @type {Uint8Array | null} */
  let zipBytes = null;
  let cacheState = 'downloaded';

  if (await storage.exists(archivePath) && await storage.exists(markerPath)) {
    try {
      const marker = JSON.parse(await storage.readText(markerPath));
      if (marker.sha256?.toLowerCase() === distribution.sha256.toLowerCase()) {
        emitProgress(requestId, { stage: 'sdk', message: `Verifying cached ${sdkKey} (SHA-256)…`, percent: 30 });
        const cachedBytes = await storage.readBytes(archivePath);
        const actualSha = await sha256Bytes(cachedBytes);
        if (actualSha === distribution.sha256.toLowerCase()) {
          zipBytes = cachedBytes;
          cacheState = 'cache-hit';
        }
      }
    } catch {
      await storage.remove(archivePath);
      await storage.remove(markerPath);
    }
  }

  if (!zipBytes) {
    if (offline) {
      throw new Error(`SDK '${sdkKey}' is not cached in this browser and offline mode is enabled.`);
    }

    const candidateUrls = [
      ...(typeof distribution.url === 'string' && distribution.url ? [distribution.url] : []),
      ...(Array.isArray(distribution.mirrors) ? distribution.mirrors : []),
      ...(import.meta.env.DEV ? [`${origin}/assets/${sdkKey}.zip`] : [])
    ];

    const errors = [];
    for (const url of candidateUrls) {
      try {
        emitProgress(requestId, { stage: 'sdk', message: `Downloading ${sdkKey}…`, percent: 32 });
        const downloaded = await downloadBytes(url, {
          name: sdkKey,
          ...transferOptions(requestId)
        });
        if (await sha256Bytes(downloaded) !== distribution.sha256.toLowerCase()) {
          throw new Error(`SDK SHA-256 mismatch for ${sdkKey} at ${url}`);
        }
        zipBytes = downloaded;
        break;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!zipBytes) {
      throw new Error(`Unable to acquire SDK '${sdkKey}': ${errors.join('; ')}`);
    }

    emitProgress(requestId, { stage: 'sdk', message: `Verifying ${sdkKey} SHA-256…`, percent: 50 });
    const actualSha = await sha256Bytes(zipBytes);
    if (actualSha !== distribution.sha256.toLowerCase()) {
      throw new Error(`SDK SHA-256 mismatch for ${sdkKey}: expected ${distribution.sha256}, got ${actualSha}`);
    }

    emitProgress(requestId, { stage: 'sdk', message: `Caching ${sdkKey} in browser storage…`, percent: 52 });
    await storage.mkdir('sdks');
    await storage.writeBytes(archivePath, zipBytes);
    await storage.writeText(markerPath, JSON.stringify({
      name: sdkManifest.name,
      version: sdkManifest.version,
      sha256: actualSha,
      bytes: zipBytes.byteLength
    }, null, 2));
  }

  emitProgress(requestId, { stage: 'sdk', message: `Extracting ${sdkKey}…`, percent: 54 });
  const unzipped = unzipSync(zipBytes);
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  for (const [rawName, data] of Object.entries(unzipped)) {
    if (rawName.endsWith('/') || rawName.endsWith('\\')) continue;
    const safeName = safeSdkArchivePath(rawName);
    files.set(safeName, data);
  }
  const wasiDir = buildWasiDirectoryMap(files.entries());
  const loaded = { files, wasiDir, cache: cacheState, version: sdkManifest.version, sha256: distribution.sha256 };
  loadedSdks.set(sdkKey, loaded);
  return loaded;
};

/**
 * Resolve any SDK dependency declared by a board manifest.
 * @param {string} origin
 * @param {string} requestId
 * @param {any} boardManifest
 * @param {boolean} offline
 */
const resolveBoardSdk = async (origin, requestId, boardManifest, offline) => {
  for (const depName of Object.keys(boardManifest.dependencies ?? {})) {
    if (!depName.endsWith('-sdk')) continue;
    try {
      const sdkManifest = await loadRegistryManifest(origin, depName, offline);
      if (sdkManifest.metadata?.distribution?.sha256) {
        const sdk = await ensureTargetSdk(origin, requestId, sdkManifest, offline);
        return { name: depName, key: `${sdkManifest.name}-${sdkManifest.version}`, sdk };
      }
    } catch (error) {
      // Propagate real SDK acquisition errors for firmware boards.
      if (boardManifest.metadata?.build?.kind === 'firmware') throw error;
    }
  }
  return null;
};

/**
 * Remap generated `sketch.cpp` diagnostic line numbers back to the original `.ino` source file.
 * @param {Array<{severity:'error'|'warning'|'info',file:string,line:number,column:number,message:string}>} diagnostics
 * @param {Array<{generatedLine:number,source:string,sourceLine:number}>} [sourceMap]
 * @param {string} [defaultFile]
 */
const remapDiagnostics = (diagnostics, sourceMap, defaultFile = 'main/main.ino') => {
  return diagnostics.map((diag) => {
    const cleanFile = diag.file.replace(/^\/tmp\//, '');
    if (sourceMap && sourceMap.length > 0 && /^(main\.cpp|sketch\.cpp)$/i.test(cleanFile)) {
      const entry = sourceMap.find((m) => m.generatedLine === diag.line)
        ?? sourceMap.filter((m) => m.generatedLine <= diag.line).pop();
      if (entry) {
        return { ...diag, file: entry.source, line: entry.sourceLine };
      }
    }
    return { ...diag, file: cleanFile === 'main.cpp' || cleanFile === 'main.c' ? defaultFile : cleanFile };
  });
};

/**
 * Build a complete project using the canonical `createWicroEngine` + `BrowserLlvmWasmToolchain`.
 * @param {string} requestId
 * @param {{origin:string,boardId:string,framework?:string,projectFiles:Record<string,string>,offline?:boolean,clean?:boolean,formats?:string[]}} payload
 */
const handleBuild = async (requestId, payload) => {
  const startedAt = Date.now();
  if (payload.clean) incrementalObjectCache.clear();

  const parsedProject = parseProjectConfiguration(payload.projectFiles['wicro.json'] ?? '{}');
  if (!parsedProject.value) throw new Error(parsedProject.error ?? 'Invalid project JSON');
  assertNoPlatformIoHooks(payload.projectFiles, parsedProject.value);
  const boardManifest = await loadRegistryManifest(payload.origin, payload.boardId, Boolean(payload.offline));
  const compiler = await ensureCompilerModule(payload.origin, requestId, Boolean(payload.offline));
  const boardSdk = await resolveBoardSdk(payload.origin, requestId, boardManifest, Boolean(payload.offline));

  /** @type {Map<string, string|Uint8Array>} */
  const virtualStore = new Map();
  virtualStore.set(`registry/${payload.boardId}/package.json`, JSON.stringify(boardManifest));
  for (const provider of boardManifest.metadata?.libraryProviders ?? []) {
    const manifest = await loadRegistryManifest(payload.origin, provider, Boolean(payload.offline));
    virtualStore.set(`registry/${provider}/package.json`, JSON.stringify(manifest));
  }

  // Populate project files + synthesized wicro.json if not explicitly present
  for (const [relPath, content] of Object.entries(payload.projectFiles)) {
    virtualStore.set(`project/${relPath.replace(/^\/+/, '')}`, content);
  }
  const existingManifest = payload.projectFiles['wicro.json'];
  /** @type {Record<string, any>} */
  let projectManifest = {};
  if (existingManifest) {
    projectManifest = JSON.parse(existingManifest);
    if (!projectManifest || typeof projectManifest !== 'object' || Array.isArray(projectManifest)) throw new Error('wicro.json must contain a JSON object');
  }
  projectManifest.board = payload.boardId;
  if (payload.framework) projectManifest.framework = payload.framework;
  virtualStore.set('project/wicro.json', JSON.stringify(projectManifest, null, 2));

  const sdkPrefix = boardSdk ? `sdk-cache/${boardSdk.key}` : undefined;

  /** @type {import('../../../../packages/core/src/index.js').WicroHostAdapter} */
  const host = {
    host: 'browser',
    libraryStorage: await getStorage(),
    resolveLibraryArtifact: libraryArtifactResolver(payload.origin),
    offline: Boolean(payload.offline),
    sdkCacheDirectory: sdkPrefix,
    async readFile(path, options) {
      if (sdkPrefix && path.startsWith(`${sdkPrefix}/`) && boardSdk) {
        const rel = path.slice(sdkPrefix.length + 1);
        const bytes = boardSdk.sdk.files.get(rel);
        if (!bytes) throw new Error(`SDK file not found: ${path}`);
        return options?.encoding === 'utf8' ? textDecoder.decode(bytes) : bytes;
      }
      const value = virtualStore.get(path);
      if (value === undefined) throw new Error(`File not found: ${path}`);
      if (options?.encoding === 'utf8' && value instanceof Uint8Array) return textDecoder.decode(value);
      if (options?.encoding === 'binary' && typeof value === 'string') return textEncoder.encode(value);
      return value;
    },
    async readdir(path) {
      const normalized = path.replace(/\/+$/, '');
      const names = new Set();
      if (sdkPrefix && (normalized === sdkPrefix || normalized.startsWith(`${sdkPrefix}/`)) && boardSdk) {
        const sub = normalized === sdkPrefix ? '' : `${normalized.slice(sdkPrefix.length + 1)}/`;
        for (const key of boardSdk.sdk.files.keys()) {
          if (sub && !key.startsWith(sub)) continue;
          const rest = sub ? key.slice(sub.length) : key;
          const first = rest.split('/')[0];
          if (first) names.add(first);
        }
        return [...names].sort();
      }
      const prefix = `${normalized}/`;
      for (const key of virtualStore.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const first = rest.split('/')[0];
        if (first) names.add(first);
      }
      if (names.size === 0) throw new Error(`Directory not found: ${path}`);
      return [...names].sort();
    },
    async writeFile(path, data) {
      virtualStore.set(path, data);
    }
  };

  const toolchain = new BrowserLlvmWasmToolchain({
    loadModule: async () => compiler.module,
    objectCache: incrementalObjectCache,
    resolvePreopen: async (virtualPath, hostPath) => {
      if (virtualPath === '/sdk' && boardSdk && hostPath === sdkPrefix) {
        return boardSdk.sdk.wasiDir;
      }
      return undefined;
    }
  });

  const engine = createWicroEngine({
    host,
    platforms,
    toolchain,
    onProgress: (ev) => {
      const scaled = typeof ev.percent === 'number' ? Math.round(55 + ev.percent * 0.45) : undefined;
      emitProgress(requestId, { stage: ev.stage, message: ev.message, percent: scaled });
    }
  });

  const result = await engine.execute({
    command: 'build',
    project: 'project',
    board: payload.boardId,
    formats: payload.formats
  });

  const value = /** @type {any} */ (result.value ?? {});
  const rawDiagText = (result.diagnostics ?? []).map((d) => d.message).join('\n');
  const parsedDiagnostics = remapDiagnostics(
    parseClangDiagnostics(rawDiagText),
    value.sourceMap,
    Object.keys(payload.projectFiles).find((f) => /\.(ino|c|cpp)$/i.test(f)) ?? 'main/main.ino'
  );

  /** @type {{bin?:Uint8Array,elf?:Uint8Array,object?:Uint8Array,extra?:Record<string,Uint8Array>}} */
  const artifacts = {};
  if (result.ok) {
    if (value.bin && virtualStore.get(value.bin) instanceof Uint8Array) {
      artifacts.bin = /** @type {Uint8Array} */ (virtualStore.get(value.bin));
    }
    if (value.elf && virtualStore.get(value.elf) instanceof Uint8Array) {
      artifacts.elf = /** @type {Uint8Array} */ (virtualStore.get(value.elf));
    }
    if (value.object && virtualStore.get(value.object) instanceof Uint8Array) {
      artifacts.object = /** @type {Uint8Array} */ (virtualStore.get(value.object));
    }
  }

  return {
    ok: result.ok,
    projectUpdates: typeof virtualStore.get('project/wicro-libraries.lock.json') === 'string' ? { 'wicro-libraries.lock.json': virtualStore.get('project/wicro-libraries.lock.json') } : {},
    value,
    diagnostics: result.diagnostics ?? [],
    parsedDiagnostics,
    artifacts,
    cacheStatus: {
      storage: storageBackend,
      compiler: compiler.cache,
      sdk: boardSdk ? boardSdk.sdk.cache : 'not-required',
      sdkName: boardSdk?.key ?? null
    },
    timingMs: Date.now() - startedAt
  };
};

/**
 * Run fast syntax-only diagnostics in the Web Worker without blocking the UI thread.
 * @param {string} requestId
 * @param {{origin:string,boardId:string,projectFiles:Record<string,string>,activeFile:string}} payload
 */
const handleDiagnose = async (requestId, payload) => {
  const boardManifest = await loadRegistryManifest(payload.origin, payload.boardId, true).catch(() =>
    loadRegistryManifest(payload.origin, payload.boardId, false)
  );
  const build = boardManifest.metadata?.build;
  if (!build?.target) return { diagnostics: [] };

  // Only run live Clang syntax checks once the compiler module is already loaded so typing never triggers a 60 MB download unexpectedly.
  if (!compiledLlvmModule) return { diagnostics: [] };

  const activeFile = payload.activeFile;
  const activeSource = payload.projectFiles[activeFile] ?? '';
  const isIno = /\.(ino|pde)$/i.test(activeFile);
  const language = /\.(ino|pde|cpp|cxx|cc)$/i.test(activeFile) ? 'c++' : 'c';

  let sourceToCheck = activeSource;
  /** @type {Array<{generatedLine:number,source:string,sourceLine:number}>|undefined} */
  let sourceMap;
  if (isIno) {
    const inoTabs = Object.fromEntries(
      Object.entries(payload.projectFiles).filter(([name]) => /\.(ino|pde)$/i.test(name))
    );
    const preprocessed = preprocessIno(inoTabs);
    sourceToCheck = preprocessed.cpp;
    sourceMap = preprocessed.sourceMap;
  }

  // Check if board SDK is already loaded in memory
  let sdkLoaded = null;
  for (const depName of Object.keys(boardManifest.dependencies ?? {})) {
    if (!depName.endsWith('-sdk')) continue;
    for (const [key, value] of loadedSdks.entries()) {
      if (key.startsWith(`${depName}-`)) {
        sdkLoaded = value;
        break;
      }
    }
  }

  const extraFiles = Object.fromEntries(
    Object.entries(payload.projectFiles).filter(([name]) => /\.(h|hpp)$/i.test(name))
  );

  const isEsp32C3 = boardManifest.metadata?.platform === 'espressif-esp32c3';
  const toolchain = new BrowserLlvmWasmToolchain({
    loadModule: async () => /** @type {WebAssembly.Module} */ (compiledLlvmModule),
    resolvePreopen: async (virtualPath) => (virtualPath === '/sdk' && sdkLoaded ? sdkLoaded.wasiDir : undefined)
  });

  const configuration = parseProjectConfiguration(payload.projectFiles['wicro.json'] ?? '{}').value;
  const flags = configuration?.build?.flags ?? [];
  const defines = configuration?.build?.defines ?? [];
  const libraryIncludes = await getLibraryIncludes(payload.projectFiles);
  const res = await toolchain.diagnoseSource({
    source: sourceToCheck,
    target: build.target,
    targetOptions: build.targetOptions ?? {},
    language,
    includeDirs: [...(isEsp32C3 && sdkLoaded ? ESP32_C3_ARDUINO_RECIPE.includeDirs : ['.']), ...libraryIncludes.includeDirs],
    compilerFlags: [...(isEsp32C3 && sdkLoaded ? ESP32_C3_ARDUINO_RECIPE.compilerFlags : []), ...(Array.isArray(flags) ? flags : [])],
    defines: [...(isEsp32C3 && sdkLoaded ? ESP32_C3_ARDUINO_RECIPE.defines : []), ...(Array.isArray(defines) ? defines : [])],
    files: { ...extraFiles, ...libraryIncludes.files },
    preopens: sdkLoaded ? { '/sdk': 'loaded' } : undefined
  });

  return {
    exitCode: res.exitCode,
    diagnostics: remapDiagnostics(res.diagnostics, sourceMap, activeFile)
  };
};

/**
 * Run Clang code completion at a 1-based line/column in the Web Worker.
 * @param {{origin:string,boardId:string,projectFiles:Record<string,string>,activeFile:string,line:number,column:number}} payload
 */
const handleComplete = async (payload) => {
  if (!compiledLlvmModule) return { candidates: [] };
  const boardManifest = await loadRegistryManifest(payload.origin, payload.boardId, true).catch(() =>
    loadRegistryManifest(payload.origin, payload.boardId, false)
  );
  const build = boardManifest.metadata?.build;
  if (!build?.target) return { candidates: [] };

  const activeFile = payload.activeFile;
  const activeSource = payload.projectFiles[activeFile] ?? '';
  const isIno = /\.(ino|pde)$/i.test(activeFile);
  const language = /\.(ino|pde|cpp|cxx|cc)$/i.test(activeFile) ? 'c++' : 'c';

  let sourceToCheck = activeSource;
  let targetLine = payload.line;
  if (isIno) {
    const inoTabs = Object.fromEntries(
      Object.entries(payload.projectFiles).filter(([name]) => /\.(ino|pde)$/i.test(name))
    );
    const preprocessed = preprocessIno(inoTabs);
    sourceToCheck = preprocessed.cpp;
    const mapped = preprocessed.sourceMap.find((m) => m.source === activeFile && m.sourceLine === payload.line);
    if (mapped) targetLine = mapped.generatedLine;
  }

  let sdkLoaded = null;
  for (const depName of Object.keys(boardManifest.dependencies ?? {})) {
    if (!depName.endsWith('-sdk')) continue;
    for (const [key, value] of loadedSdks.entries()) {
      if (key.startsWith(`${depName}-`)) {
        sdkLoaded = value;
        break;
      }
    }
  }

  const isEsp32C3 = boardManifest.metadata?.platform === 'espressif-esp32c3';
  const toolchain = new BrowserLlvmWasmToolchain({
    loadModule: async () => /** @type {WebAssembly.Module} */ (compiledLlvmModule),
    resolvePreopen: async (virtualPath) => (virtualPath === '/sdk' && sdkLoaded ? sdkLoaded.wasiDir : undefined)
  });

  const configuration = parseProjectConfiguration(payload.projectFiles['wicro.json'] ?? '{}').value;
  const defines = configuration?.build?.defines ?? [];
  const libraryIncludes = await getLibraryIncludes(payload.projectFiles);
  const res = await toolchain.completeSource({
    source: sourceToCheck,
    target: build.target,
    targetOptions: build.targetOptions ?? {},
    language,
    includeDirs: [...(isEsp32C3 && sdkLoaded ? ESP32_C3_ARDUINO_RECIPE.includeDirs : ['.']), ...libraryIncludes.includeDirs],
    defines: [...(isEsp32C3 && sdkLoaded ? ESP32_C3_ARDUINO_RECIPE.defines : []), ...(Array.isArray(defines) ? defines : [])],
    files: libraryIncludes.files,
    preopens: sdkLoaded ? { '/sdk': 'loaded' } : undefined,
    line: targetLine,
    column: payload.column
  });

  return { candidates: res.candidates };
};

/**
 * Inspect persistent cache state in OPFS.
 */
const handleCacheStatus = async () => {
  const storage = await getStorage();
  /** @type {string[]} */
  let sdks = [];
  let hasCompiler = Boolean(compiledLlvmModule);
  try {
    if (await storage.exists('sdks')) {
      sdks = (await storage.readdir('sdks')).filter((name) => name.endsWith('.zip')).map((name) => name.replace(/\.zip$/, ''));
    }
    if (!hasCompiler && await storage.exists('compilers/llvm-wasm/202611141634-v6.0.3/llvm.wasm')) {
      hasCompiler = true;
    }
  } catch {
    // Ignore empty OPFS directories.
  }
  return {
    storage: storageBackend,
    compilerCached: hasCompiler,
    compilerLoaded: Boolean(compiledLlvmModule),
    cachedSdks: sdks,
    loadedSdks: [...loadedSdks.keys()],
    incrementalObjects: incrementalObjectCache.size
  };
};

const handleClearCache = async () => {
  const storage = await getStorage();
  await storage.remove('compilers');
  await storage.remove('sdks');
  await storage.remove('registry');
  compiledLlvmModule = null;
  compilerCacheState = 'not-installed';
  loadedSdks.clear();
  incrementalObjectCache.clear();
  registryManifestCache.clear();
  return handleCacheStatus();
};

/** @param {Record<string,string>} projectFiles */
const getLibraryIncludes = async (projectFiles) => {
  if (!projectFiles['wicro-libraries.lock.json']) return createLibraryCompilePlan([]);
  const lock = JSON.parse(projectFiles['wicro-libraries.lock.json']);
  const manager = new LibraryManager({ storage: await getStorage(), offline: true });
  const installed = [];
  for (const release of lock.libraries ?? []) installed.push({ release, files: await manager.load(release) });
  return createLibraryCompilePlan(installed);
};

/** @param {string} origin @param {string} url */
const resolveLibraryArtifact = async (origin, url) => {
  const endpoint = import.meta.env.DEV ? `${origin}/api/library-download` : import.meta.env.VITE_WICRO_LIBRARY_METADATA_URL;
  if (!endpoint) throw new Error('Configure a PlatformIO redirect metadata endpoint for this deployment');
  const separator = endpoint.includes('?') ? '&' : '?';
  const response = await fetch(`${endpoint}${separator}url=${encodeURIComponent(url)}`);
  const value = await response.json();
  if (!response.ok || !value.url) throw new Error(`PlatformIO redirect metadata lookup failed: ${value.error ?? response.status}`);
  return String(value.url);
};

/** @param {string} origin @returns {((url:string)=>Promise<string>)|undefined} */
const libraryArtifactResolver = (origin) => import.meta.env.DEV || import.meta.env.VITE_WICRO_LIBRARY_METADATA_URL ? (url) => resolveLibraryArtifact(origin, url) : undefined;

/** @type {LibraryCatalog|null} */
let libraryCatalog = null;
/** @param {any} payload */
const getLibraryCatalog = async (payload) => {
  const storage = await getStorage();
  if (storageBackend !== 'opfs') throw new Error('Library browsing and installation require persistent OPFS storage in this browser.');
  libraryCatalog ??= new LibraryCatalog({ storage });
  libraryCatalog.offline = Boolean(payload.offline);
  return libraryCatalog;
};

/** @param {any} payload @param {string} requestId */
const handleLibraryInstall = async (payload, requestId) => {
  const catalog = await getLibraryCatalog(payload);
  const configuration = parseProjectConfiguration(payload.projectFiles['wicro.json'] ?? '{}');
  if (!configuration.value) throw new Error(configuration.error ?? 'Invalid project JSON');
  assertNoPlatformIoHooks(payload.projectFiles, configuration.value);
  const release = await catalog.resolve(payload.request);
  const request = { ...payload.request, name: release.name, owner: release.owner, version: release.version };
  const requests = [...(configuration.value.libraries ?? []).filter((/** @type {any} */ entry) => !(entry.provider === request.provider && entry.name === request.name && entry.owner === request.owner)), request];
  const board = await loadRegistryManifest(payload.origin, payload.boardId, Boolean(payload.offline));
  const providers = [];
  for (const name of board.metadata?.libraryProviders ?? []) providers.push((await loadRegistryManifest(payload.origin, name, Boolean(payload.offline))).metadata.library);
  const mcu = String(board.metadata?.mcu ?? '');
  const architecture = /^ESP32/i.test(mcu) ? 'esp32' : /^ESP8266/i.test(mcu) ? 'esp8266' : /^STM32/i.test(mcu) ? 'stm32' : /^RP2/i.test(mcu) ? 'rp2040' : board.metadata?.architecture;
  const manager = new LibraryManager({ storage: await getStorage(), catalog, offline: Boolean(payload.offline), target: payload.boardId, architecture, framework: configuration.value.framework ?? 'arduino', frameworkLibraries: providers, resolveArtifactUrl: libraryArtifactResolver(payload.origin), ...transferOptions(requestId) });
  const result = await manager.ensureProject(requests);
  return { requests, lock: result.lock, libraries: result.lock.libraries.map((entry) => ({ name: entry.name, version: entry.version })) };
};

/** @param {any} payload */
const handleLibraryFiles = async (payload) => {
  const manager = new LibraryManager({ storage: await getStorage(), offline: Boolean(payload.offline) });
  const files = await manager.load(payload.release);
  if (!payload.path) return { paths: Object.keys(files).sort() };
  const bytes = files[payload.path];
  if (!bytes) throw new Error('Library file does not exist');
  return { text: new TextDecoder().decode(bytes.subarray(0, 256 * 1024)), truncated: bytes.length > 256 * 1024 };
};

self.addEventListener('message', async (event) => {
  const { id, type, payload } = event.data ?? {};
  if (type === 'transferControl') {
    const control = downloadControls.get(payload.requestId);
    if (payload.action === 'pause') control?.pause();
    if (payload.action === 'resume') control?.resume();
    if (payload.action === 'cancel') control?.cancel();
    return;
  }
  downloadControls.set(id, new DownloadControl());
  try {
    if (type === 'librarySearch' || type === 'libraryInstall' || type === 'libraryFiles') {
      const result = type === 'librarySearch' ? await (await getLibraryCatalog(payload)).search(payload.provider, payload.query, Boolean(payload.refresh)) : type === 'libraryInstall' ? await handleLibraryInstall(payload, id) : await handleLibraryFiles(payload);
      self.postMessage({ type: 'result', id, ok: true, result });
      return;
    }
    if (type === 'build') {
      const result = await handleBuild(id, payload);
      self.postMessage({ type: 'result', id, ok: true, result });
      return;
    }
    if (type === 'diagnose') {
      const result = await handleDiagnose(id, payload);
      self.postMessage({ type: 'result', id, ok: true, result });
      return;
    }
    if (type === 'complete') {
      const result = await handleComplete(payload);
      self.postMessage({ type: 'result', id, ok: true, result });
      return;
    }
    if (type === 'cacheStatus') {
      const result = await handleCacheStatus();
      self.postMessage({ type: 'result', id, ok: true, result });
      return;
    }
    if (type === 'clearCache') {
      const result = await handleClearCache();
      self.postMessage({ type: 'result', id, ok: true, result });
      return;
    }
    throw new Error(`Unknown build worker message type: ${String(type)}`);
  } catch (error) {
    self.postMessage({
      type: 'result',
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  } finally { downloadControls.delete(id); }
});
