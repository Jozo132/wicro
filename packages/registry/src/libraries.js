import { satisfies } from 'semver';
import { parseLibraryProperties, parsePlatformIoIni } from '../../arduino/src/index.js';
import { LibraryCatalog, librarySemver } from './library-catalog.js';
import { downloadBytes } from './download.js';
import { sha256Bytes } from './sdk.js';
import { extractLibraryArchive, safeLibraryPath } from './library-archive.js';

/** @typedef {import('./library-catalog.js').LibraryRelease} LibraryRelease */
/** @typedef {import('./library-catalog.js').LibraryRequest} LibraryRequest */
/** @typedef {{lockfileVersion:1,requests:LibraryRequest[],target:string,libraries:LibraryRelease[]}} LibraryLock */

/** @param {Record<string,Uint8Array>} files @param {LibraryRelease} [release] */
export const inspectLibrary = (files, release) => {
  const decode = new TextDecoder();
  const properties = files['library.properties'] ? parseLibraryProperties(decode.decode(files['library.properties'])) : {};
  const manifest = files['library.json'] ? JSON.parse(decode.decode(files['library.json'])) : {};
  const cdcDfuRecipe = release?.provider === 'platformio' && release.owner === 'jozo132' && release.name === 'cdc-dfu' && release.version === '1.1.2' && release.sha256 === '64911fd4004b4fc8e311fb55cfc06e0d7f5fd2f8fc215c1d22480d92e13e3afe';
  if (!cdcDfuRecipe && (manifest.build?.extraScript || manifest.extraScript)) throw new Error(`Library requires a PlatformIO Python/SCons hook (${manifest.build?.extraScript ?? manifest.extraScript}). Port its required operations to a shared Wicro build recipe; hooks are not silently skipped.`);
  for (const key of Object.keys(manifest.build ?? {})) {
    if (![...['srcDir', 'includeDir', 'flags', 'libArchive'], ...(cdcDfuRecipe ? ['extraScript', 'srcFilter'] : [])].includes(key)) throw new Error(`Unsupported PlatformIO library build option '${key}'; provide an explicit Wicro recipe before importing it`);
  }
  if (properties.precompiled && properties.precompiled !== 'false' || Object.keys(files).some((name) => /\.(a|o|so|dll|exe)$/i.test(name))) throw new Error('Precompiled library binaries require a verified target/ABI recipe; import source libraries instead');
  /** @type {Array<{name:string,version?:string,owner?:string}>} */
  const dependencies = [];
  for (const value of (properties.depends ?? '').split(/,(?![^()]*\))/).filter(Boolean)) {
    const match = value.trim().match(/^(.+?)(?:\s*\((.+)\))?$/);
    if (match) dependencies.push({ name: match[1].trim(), version: match[2]?.replace(/&&/g, ' ') });
  }
  if (Array.isArray(manifest.dependencies)) {
    for (const dependency of manifest.dependencies) {
      if (!dependency.name || dependency.platforms || dependency.frameworks) throw new Error('Conditional PlatformIO dependencies require an explicit Wicro recipe');
      dependencies.push({ name: dependency.name, owner: dependency.owner, version: dependency.version });
    }
  } else {
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (typeof version !== 'string') throw new Error(`Unsupported dependency specification for ${name}`);
      dependencies.push({ name, version });
    }
  }
  const modern = Object.keys(files).some((path) => path.startsWith('src/'));
  /** @param {string} path */
  const rootPath = (path) => !path || /^\.(?:\/)?$/.test(path) ? '' : safeLibraryPath(path);
  const sourceRoot = rootPath(String(manifest.build?.srcDir ?? (modern ? 'src' : '')));
  const includeRoot = rootPath(String(manifest.build?.includeDir ?? 'include'));
  const sourceFiles = Object.keys(files).filter((path) => /\.(c|cc|cpp|cxx|s|S|asm)$/.test(path) && (
    sourceRoot ? path.startsWith(`${sourceRoot}/`) : !path.includes('/') || path.startsWith('utility/')
  )).sort();
  const roots = [...new Set([sourceRoot, includeRoot, ...(sourceRoot ? [] : ['', 'utility'])])].filter((root) => !root || Object.keys(files).some((name) => name.startsWith(`${root}/`)));
  const rawFlags = manifest.build?.flags ?? [];
  if (!Array.isArray(rawFlags) && typeof rawFlags !== 'string') throw new Error('Library build.flags must be a string or array');
  // Accept ordinary flags. Directory-bearing flags need an explicit recipe so
  // native paths and PlatformIO variables never masquerade as WASI paths.
  const flags = Array.isArray(rawFlags) ? rawFlags : rawFlags.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((flag) => flag.replace(/["']/g, '')) ?? [];
  if (flags.some((/** @type {unknown} */ flag) => typeof flag !== 'string' || /^-(?:I|L|include|isystem)/.test(flag) || flag.includes('${'))) throw new Error('Library include/library path flags require an explicit Wicro recipe');
  return { recipe: cdcDfuRecipe ? 'cdc-dfu-1.1.2' : null, globalDefines: cdcDfuRecipe ? ['DTR_TOGGLING_SEQ'] : [], name: manifest.name ?? properties.name, version: manifest.version ?? properties.version, dependencies, sourceFiles, includeRoots: roots, flags, architectures: properties.architectures?.split(',').map((value) => value.trim()) ?? [], frameworks: manifest.frameworks };
};

/** Refuse declared project hooks before any build downloads or compilation. @param {Record<string,string>} files @param {Record<string,any>} config */
export const assertNoPlatformIoHooks = (files, config) => {
  if (config.extra_scripts || config.build?.extra_scripts || config.build?.extraScripts) throw new Error('PlatformIO extra_scripts require Python/SCons and must be ported to an explicit Wicro recipe');
  if (files['platformio.ini']) {
    for (const section of Object.values(parsePlatformIoIni(files['platformio.ini']))) {
      if (section.extra_scripts?.trim()) throw new Error('platformio.ini declares extra_scripts: Python/SCons pre/post hooks are unsupported; port the required operations before building');
    }
  }
};

/** Object-key and declaration order must not cause an existing lock to upgrade. @param {LibraryRequest[]} requests */
const requestIdentity = (requests) => JSON.stringify(requests.map((request) => JSON.stringify({ provider: request.provider, name: request.name, owner: request.owner ?? '', version: request.version ?? '*', url: request.url ?? '', sha256: request.sha256?.toLowerCase() ?? '', archiveType: request.archiveType ?? '' })).sort());

export class LibraryManager {
  /** @param {{storage:import('./sdk.js').SdkStorage,fetch?:typeof fetch,catalog?:LibraryCatalog,offline?:boolean,target?:string,architecture?:string,framework?:string,frameworkLibraries?:LibraryRelease[],resolveArtifactUrl?:(url:string)=>Promise<string>,control?:import('./download.js').DownloadControl,progress?:(event:import('./download.js').DownloadProgress)=>void}} options */
  constructor(options) {
    this.storage = options.storage;
    this.fetch = options.fetch ?? fetch;
    this.offline = options.offline ?? false;
    this.catalog = options.catalog ?? new LibraryCatalog(options);
    this.target = options.target ?? '';
    this.architecture = options.architecture;
    this.framework = options.framework;
    this.frameworkLibraries = options.frameworkLibraries ?? [];
    this.resolveArtifactUrl = options.resolveArtifactUrl;
    this.control = options.control;
    this.progress = options.progress;
  }

  /** @param {LibraryRelease} release @returns {Promise<Record<string,Uint8Array>>} */
  async load(release) {
    if (!/^[a-f0-9]{64}$/i.test(release.sha256)) throw new Error(`Library ${release.name} has no trusted SHA-256 identity`);
    const root = `libraries/${release.sha256}`;
    const markerPath = `${root}/.wicro-package.json`;
    if (await this.storage.exists(markerPath)) {
      try {
        const marker = JSON.parse(await this.storage.readText(markerPath));
        if (marker.sha256 !== release.sha256 || !Object.keys(marker.files ?? {}).length) throw new Error('Invalid library cache marker');
        /** @type {Record<string,Uint8Array>} */
        const cached = {};
        for (const [path, hash] of Object.entries(marker.files)) {
          safeLibraryPath(path);
          const bytes = await this.storage.readBytes(`${root}/${path}`);
          if (await sha256Bytes(bytes) !== hash) throw new Error(`Library cache corruption: ${path}`);
          cached[path] = bytes;
        }
        this.checkCompatibility(release, cached);
        return cached;
      } catch (error) {
        if (this.offline) throw new Error(`Cached library ${release.name} is unusable offline: ${error instanceof Error ? error.message : String(error)}`);
        await this.storage.remove(root);
      }
    }
    if (this.offline) throw new Error(`Library ${release.name}@${release.version} is not cached and offline mode is enabled`);
    /** @type {Record<string,Uint8Array>} */
    let files = {};
    if (release.provider === 'files') {
      if (!release.files || await sha256Bytes(new TextEncoder().encode(JSON.stringify(release.files))) !== release.sha256) throw new Error('Invalid framework library file inventory');
      for (const [path, entry] of Object.entries(release.files)) {
        safeLibraryPath(path);
        const bytes = await downloadBytes(entry.url, { fetch: this.fetch, control: this.control, progress: this.progress, name: `${release.name}/${path}` });
        if (await sha256Bytes(bytes) !== entry.sha256) throw new Error(`Framework library checksum mismatch: ${path}`);
        files[path] = bytes;
      }
    } else {
      if (!release.url) throw new Error(`Library archive URL is missing for ${release.name}`);
      if (release.provider === 'platformio' && this.resolveArtifactUrl && new URL(release.url).pathname.startsWith('/download/')) release.url = await this.resolveArtifactUrl(release.url);
      const bytes = await downloadBytes(release.url, { fetch: this.fetch, control: this.control, progress: this.progress, name: release.name });
      if (await sha256Bytes(bytes) !== release.sha256.toLowerCase()) throw new Error(`Library SHA-256 mismatch: ${release.name}`);
      files = extractLibraryArchive(bytes, release.archiveType ?? 'zip');
    }
    this.checkCompatibility(release, files);
    const staging = `${root}.staging-${Math.random().toString(36).slice(2)}`;
    /** @type {Record<string,string>} */
    const hashes = {};
    try {
      for (const [path, data] of Object.entries(files)) {
        await this.storage.writeBytes(`${staging}/${path}`, data);
        hashes[path] = await sha256Bytes(data);
      }
      await this.storage.writeText(`${staging}/.wicro-package.json`, JSON.stringify({ sha256: release.sha256, files: hashes }));
      await this.storage.remove(root);
      if (this.storage.rename) await this.storage.rename(staging, root);
      else {
        for (const path of [...Object.keys(files), '.wicro-package.json']) await this.storage.writeBytes(`${root}/${path}`, await this.storage.readBytes(`${staging}/${path}`));
      }
    } finally { await this.storage.remove(staging); }
    return files;
  }

  /** @param {LibraryRelease} release @param {Record<string,Uint8Array>} files */
  checkCompatibility(release, files) {
    const metadata = inspectLibrary(files, release);
    const architectures = metadata.architectures.length ? metadata.architectures : release.architectures ?? [];
    if (this.architecture && architectures.length && !architectures.includes('*') && !architectures.includes(this.architecture)) throw new Error(`${release.name} does not support Arduino architecture '${this.architecture}'`);
    if (metadata.frameworks && this.framework && metadata.frameworks !== '*' && !(Array.isArray(metadata.frameworks) ? metadata.frameworks : [metadata.frameworks]).includes(this.framework)) throw new Error(`${release.name} does not support framework '${this.framework}'`);
  }

  /** @param {LibraryRequest[]} requests @param {LibraryLock|null} [existing] */
  async ensureProject(requests, existing = null) {
    if (!Array.isArray(requests)) throw new Error('wicro.json libraries must be an array of library declarations');
    /** @type {Map<string,{release:LibraryRelease,files:Record<string,Uint8Array>}>} */
    const installed = new Map();
    const target = `${this.target}:${this.framework ?? ''}:${this.frameworkLibraries.map((entry) => entry.sha256).join(',')}`;
    if (existing?.lockfileVersion === 1 && existing.target === target && requestIdentity(existing.requests) === requestIdentity(requests)) {
      for (const release of existing.libraries) installed.set(release.id, { release, files: await this.load(release) });
    } else {
      /** @param {LibraryRequest} request @returns {Promise<void>} */
      const visit = async (request) => {
        const release = await this.catalog.resolve(request);
        const previous = installed.get(release.id);
        if (previous) {
          if (!satisfies(librarySemver(previous.release.version) ?? previous.release.version, request.version ?? '*')) throw new Error(`Conflicting library versions requested for ${release.id}`);
          return;
        }
        if (installed.size >= 100) throw new Error('Library dependency graph exceeds 100 packages');
        const files = await this.load(release);
        installed.set(release.id, { release, files });
        const dependencies = [...(release.dependencies ?? []), ...inspectLibrary(files, release).dependencies];
        for (const dependency of dependencies) await visit({ provider: request.provider === 'platformio' ? 'platformio' : 'arduino', ...dependency });
        if (installed.size > 100) throw new Error('Library dependency graph exceeds 100 packages');
      };
      for (const request of requests) await visit(request);
      const needsBuses = [...installed.values()].some(({ files }) => Object.entries(files).some(([name, bytes]) => /\.(h|hpp|cpp|c)$/.test(name) && /#\s*include\s*[<"](?:Wire|SPI)\.h[>"]/.test(new TextDecoder().decode(bytes))));
      if (needsBuses) for (const release of this.frameworkLibraries) installed.set(release.id, { release, files: await this.load(release) });
    }
    /** @type {LibraryLock} */
    const lock = { lockfileVersion: 1, requests, target, libraries: [...installed.values()].map((entry) => entry.release) };
    return { lock, installed: [...installed.values()] };
  }
}
