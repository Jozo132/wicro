/** @typedef {object} SdkStorage
 * @property {(path:string) => Promise<boolean>} exists
 * @property {(path:string) => Promise<string>} readText
 * @property {(path:string) => Promise<Uint8Array>} readBytes
 * @property {(path:string, text:string) => Promise<void>} writeText
 * @property {(path:string, data:Uint8Array) => Promise<void>} writeBytes
 * @property {(path:string) => Promise<void>} mkdir
 * @property {(path:string) => Promise<void>} remove
 * @property {(path:string) => Promise<string[]>} readdir
 */

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
   * @param {{cacheName?:string,localSources?:Record<string,string>}} [options]
   * @returns {Promise<SdkInstallResult>}
   */
  async ensure(manifest, options = {}) {
    const distribution = /** @type {{distribution?:SdkDistribution}} */ (manifest.metadata ?? {}).distribution;
    if (!distribution?.url) throw new Error(`SDK package '${manifest.name}' has no downloadable distribution`);

    const cacheName = options.cacheName ?? `${manifest.name}-${manifest.version}`;
    const pending = this.pending.get(cacheName);
    if (pending) return pending;

    const promise = this.ensureUncached(manifest, distribution, cacheName, options);
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
   * @param {{cacheName?:string,localSources?:Record<string,string>}} [options]
   * @returns {Promise<SdkInstallResult>}
   */
  async ensureUncached(manifest, distribution, cacheName, options = {}) {
    const markerPath = `${cacheName}/package.json`;
    if (await this.storage.exists(markerPath)) {
      try {
        const marker = JSON.parse(await this.storage.readText(markerPath));
        if (marker.name === manifest.name && marker.version === manifest.version && typeof marker.sha256 === 'string') {
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
        }
      } catch {
        await this.storage.remove(cacheName);
      }
    }

    await this.storage.remove(cacheName);
    await this.storage.mkdir(cacheName);

    /** @type {string[]} */
    const urls = [];
    const localSource = options.localSources?.[manifest.name];
    if (typeof localSource === 'string' && localSource.length > 0) urls.push(localSource);
    urls.push(...[distribution.url, ...(distribution.mirrors ?? [])].filter((url) => typeof url === 'string' && url.length > 0));

    let bytes;
    let lastError;
    for (const url of urls) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
          if (/^file:\/\//.test(url) || /^\//.test(url) || /^[A-Za-z]:[\\/]/.test(url)) {
            const { readFile } = await import('node:fs/promises');
            bytes = new Uint8Array(await readFile(/^file:\/\//.test(url) ? new URL(url) : url));
          } else {
            const response = await this.fetch(url, { headers: { accept: 'application/zip' } });
            if (!response.ok) throw new Error(`SDK download failed (${response.status}) for ${manifest.name}: ${url}`);
            bytes = new Uint8Array(await response.arrayBuffer());
          }
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (bytes) break;
    }
    if (!bytes) {
      await this.storage.remove(cacheName);
      throw new Error(`SDK download failed for ${manifest.name} after local-cache, mirror and retry attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }
    const sha256 = await sha256Bytes(bytes);
    if (typeof distribution.sha256 !== 'string' || distribution.sha256.length !== 64) {
      await this.storage.remove(cacheName);
      throw new Error(`SDK '${manifest.name}' has no trusted SHA-256 archive identity. Configure a verified immutable distribution before installation.`);
    }
    if (distribution.sha256.toLowerCase() !== sha256) {
      await this.storage.remove(cacheName);
      throw new Error(`SDK SHA-256 mismatch for ${manifest.name}: expected ${distribution.sha256}, got ${sha256}`);
    }

    let entries;
    try {
      const { unzipSync } = await import('fflate');
      entries = unzipSync(bytes);
    } catch (error) {
      await this.storage.remove(cacheName);
      throw new Error(`SDK archive extraction failed for ${manifest.name}: ${error instanceof Error ? error.message : String(error)}`);
    }

    /** @type {Record<string,string>} */
    const fileHashes = {};
    for (const [rawName, data] of Object.entries(entries)) {
      if (rawName.endsWith('/') || rawName.endsWith('\\')) continue;
      const safeName = safeSdkArchivePath(rawName);
      await this.storage.mkdir(`${cacheName}/${safeName}`.split('/').slice(0, -1).join('/'));
      await this.storage.writeBytes(`${cacheName}/${safeName}`, data);
      fileHashes[safeName] = await sha256Bytes(data);
    }

    const marker = {
      name: manifest.name,
      version: manifest.version,
      sha256,
      files: fileHashes,
      upstreamCommit: typeof manifest.metadata?.upstreamCommit === 'string' ? manifest.metadata.upstreamCommit : undefined,
      distribution: distribution.url
    };
    await this.storage.writeText(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
    await this.updateLock(manifest, sha256);

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
  const source = new ArrayBuffer(bytes.length);
  const view = new Uint8Array(source);
  for (let index = 0; index < bytes.length; index++) view[index] = bytes[index] ?? 0;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', source);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};
