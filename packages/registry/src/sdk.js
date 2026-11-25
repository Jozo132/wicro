import { downloadBytes } from './download.js';

/** @typedef {object} SdkStorage
 * @property {(path:string) => Promise<boolean>} exists
 * @property {(path:string) => Promise<string>} readText
 * @property {(path:string) => Promise<Uint8Array>} readBytes
 * @property {(path:string, text:string) => Promise<void>} writeText
 * @property {(path:string, data:Uint8Array) => Promise<void>} writeBytes
 * @property {(path:string) => Promise<void>} mkdir
 * @property {(path:string) => Promise<void>} remove
 * @property {(path:string) => Promise<string[]>} readdir
 * @property {(from:string, to:string) => Promise<void>} [rename]
 */

export const SDK_CACHE_SCHEMA_VERSION = 2;

/** @typedef {object} SdkDistribution
 * @property {string} url
 * @property {'zip'} [archiveType]
 * @property {string[]} [mirrors]
 * @property {string|null} [sha256]
 */

/** @typedef {object} SdkInstallResult
 * @property {string} name
 * @property {string} version
 * @property {string} target
 * @property {string} sha256
 * @property {'downloaded'|'cache-hit'} cache
 */

export class SdkLifecycleManager {
  /**
   * @param {{storage:SdkStorage,fetch?:typeof fetch,lockPath?:string}} options
   */
  constructor(options) {
    if (!options.storage) throw new Error('A persistent SDK storage adapter is required');
    this.storage = options.storage;
    this.fetch = options.fetch ?? fetch;
    this.lockPath = options.lockPath ?? 'wicro-sdk-lock.json';
    /** @type {Map<string,Promise<SdkInstallResult>>} */
    this.pending = new Map();
  }

  /**
   * @param {import('./index.js').WicroPackageManifest} manifest
   * @param {{cacheName?:string,localSources?:Record<string,string>,offline?:boolean}} [options]
   * @returns {Promise<SdkInstallResult>}
   */
  async ensure(manifest, options = {}) {
    const distribution = /** @type {{distribution?:SdkDistribution}} */ (manifest.metadata ?? {}).distribution;
    if (!distribution?.url && !options.localSources?.[manifest.name] && !manifest.metadata?.composition) {
      throw new Error(`SDK package '${manifest.name}' has no downloadable distribution`);
    }

    const cacheName = options.cacheName ?? `${manifest.name}-${manifest.version}`;
    const pending = this.pending.get(cacheName);
    if (pending) return pending;

    const promise = this.ensureUncached(manifest, distribution ?? { url: '' }, cacheName, options);
    this.pending.set(cacheName, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(cacheName);
    }
  }

  /**
   * @param {import('./index.js').WicroPackageManifest} manifest
   * @param {SdkDistribution} distribution
   * @param {string} cacheName
   * @param {{cacheName?:string,localSources?:Record<string,string>,offline?:boolean}} [options]
   * @returns {Promise<SdkInstallResult>}
   */
  async ensureUncached(manifest, distribution, cacheName, options = {}) {
    const markerPath = `${cacheName}/package.json`;
    if (await this.storage.exists(markerPath)) {
      try {
        const marker = JSON.parse(await this.storage.readText(markerPath));
        const expectedArchiveSha = typeof distribution.sha256 === 'string' ? distribution.sha256.toLowerCase() : null;
        const shaMatches = !expectedArchiveSha || (typeof marker.sha256 === 'string' && marker.sha256.toLowerCase() === expectedArchiveSha);
        if (marker.name === manifest.name && marker.version === manifest.version && typeof marker.sha256 === 'string' && shaMatches) {
          const files = /** @type {Record<string,string>|undefined} */ (marker.files);
          let intact = Boolean(files);
          if (files) {
            for (const [path, expected] of Object.entries(files)) {
              if (!await this.storage.exists(`${cacheName}/${path}`)) { intact = false; break; }
              const bytes = await this.storage.readBytes(`${cacheName}/${path}`);
              if (await sha256Bytes(bytes) !== expected) { intact = false; break; }
            }
          }
          if (!intact) {
            await this.storage.remove(cacheName);
          } else {
            return {
              name: manifest.name,
              version: manifest.version,
              target: cacheName,
              sha256: marker.sha256,
              cache: 'cache-hit'
            };
          }
        } else {
          await this.storage.remove(cacheName);
        }
      } catch {
        await this.storage.remove(cacheName);
      }
    }

    if (options.offline) {
      throw new Error(`SDK '${manifest.name}@${manifest.version}' is not present in the local cache and offline mode is enabled`);
    }

    const stagingName = typeof this.storage.rename === 'function'
      ? `${cacheName}.staging-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      : cacheName;
    if (stagingName === cacheName) await this.storage.remove(cacheName);
    await this.storage.mkdir(stagingName);

    /** @type {string[]} */
    const urls = [];
    const localSource = options.localSources?.[manifest.name];
    if (typeof localSource === 'string' && localSource.length > 0) urls.push(localSource);
    urls.push(...[distribution.url, ...(distribution.mirrors ?? [])].filter((url) => typeof url === 'string' && url.length > 0));

    if (typeof distribution.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(distribution.sha256)) {
      await this.storage.remove(stagingName);
      throw new Error(`SDK '${manifest.name}' has no trusted SHA-256 archive identity. Configure a verified immutable distribution before installation.`);
    }
    let bytes;
    let lastError;
    for (const url of urls) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
          if (/^file:\/\//.test(url) || (typeof process !== 'undefined' && process.versions?.node && (/^\//.test(url) || /^[A-Za-z]:[\\/]/.test(url)))) {
            const { readFile } = await import('node:fs/promises');
            bytes = new Uint8Array(await readFile(/^file:\/\//.test(url) ? new URL(url) : url));
          } else {
            bytes = await downloadBytes(url, { fetch: this.fetch, name: manifest.name });
          }
          if (await sha256Bytes(bytes) !== distribution.sha256.toLowerCase()) {
            throw new Error(`SDK SHA-256 mismatch for ${manifest.name} at ${url}`);
          }
          break;
        } catch (error) {
          bytes = undefined;
          lastError = error;
        }
      }
      if (bytes) break;
    }
    if (!bytes && manifest.metadata?.composition) {
      try {
        const { composeSdkArchive } = await import('./sdk-composition.js');
        bytes = await composeSdkArchive(/** @type {{sources:import('./sdk-composition.js').CompositionSource[]}} */ (manifest.metadata.composition), { storage: this.storage, fetch: this.fetch });
        if (await sha256Bytes(bytes) !== distribution.sha256.toLowerCase()) throw new Error('Composed SDK checksum mismatch');
      } catch (error) { await this.storage.remove(stagingName); throw error; }
    }
    if (!bytes) {
      await this.storage.remove(stagingName);
      throw new Error(`SDK download failed for ${manifest.name} after local-cache, mirror and retry attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }
    const sha256 = await sha256Bytes(bytes);

    let entries;
    try {
      const { unzipSync } = await import('fflate');
      entries = unzipSync(bytes);
    } catch (error) {
      await this.storage.remove(stagingName);
      throw new Error(`SDK archive extraction failed for ${manifest.name}: ${error instanceof Error ? error.message : String(error)}`);
    }

    /** @type {Record<string,string>} */
    const fileHashes = {};
    try {
      for (const [rawName, data] of Object.entries(entries)) {
        if (rawName.endsWith('/') || rawName.endsWith('\\')) continue;
        const safeName = safeSdkArchivePath(rawName);
        const parent = `${stagingName}/${safeName}`.split('/').slice(0, -1).join('/');
        if (parent) await this.storage.mkdir(parent);
        await this.storage.writeBytes(`${stagingName}/${safeName}`, data);
        fileHashes[safeName] = await sha256Bytes(data);
      }

      const marker = {
        cacheSchemaVersion: SDK_CACHE_SCHEMA_VERSION,
        name: manifest.name,
        version: manifest.version,
        sha256,
        files: fileHashes,
        upstreamCommit: typeof manifest.metadata?.upstreamCommit === 'string' ? manifest.metadata.upstreamCommit : undefined,
        distribution: distribution.url
      };
      await this.storage.writeText(`${stagingName}/package.json`, `${JSON.stringify(marker, null, 2)}\n`);
      if (stagingName !== cacheName && typeof this.storage.rename === 'function') {
        await this.storage.rename(stagingName, cacheName);
      }
      await this.updateLock(manifest, sha256);
    } catch (error) {
      await this.storage.remove(stagingName);
      throw error;
    }

    return { name: manifest.name, version: manifest.version, target: cacheName, sha256, cache: 'downloaded' };
  }

  /** @param {import('./index.js').WicroPackageManifest} manifest @param {string} sha256 */
  async updateLock(manifest, sha256) {
    /** @type {{lockfileVersion:number,packages:Record<string,{version:string,sha256:string,source:string}>}} */
    let lock = { lockfileVersion: 1, packages: {} };
    if (await this.storage.exists(this.lockPath)) {
      try {
        lock = JSON.parse(await this.storage.readText(this.lockPath));
      } catch {
        lock = { lockfileVersion: 1, packages: {} };
      }
    }
    lock.lockfileVersion = 1;
    lock.packages[manifest.name] = {
      version: manifest.version,
      sha256,
      source: /** @type {{distribution?:SdkDistribution}} */ (manifest.metadata ?? {}).distribution?.url ?? 'unknown'
    };
    await this.storage.writeText(this.lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  }

  /** @param {string} name */
  async cleanup(name) {
    await this.storage.remove(name);
  }
}

/** @param {string} name */
export const safeSdkArchivePath = (name) => {
  const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('../') || normalized.split('/').includes('..')) {
    throw new Error(`Unsafe SDK archive path: ${name}`);
  }
  return normalized;
};

/** @param {Uint8Array} bytes */
export const sha256Bytes = async (bytes) => {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 support is unavailable in this host');
  const source = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(source).set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', source);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};
