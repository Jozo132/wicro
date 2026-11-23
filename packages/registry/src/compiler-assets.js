/** @typedef {object} CompilerArtifact
 * @property {string|null} [url]
 * @property {string[]} [mirrors]
 * @property {'br'|'gzip'|'deflate'|null} [compression]
 * @property {string|null} [sha256]
 * @property {string|null} [uncompressedSha256]
 * @property {string} filename
 */

/** @typedef {object} CompilerAssetManifest
 * @property {string} name
 * @property {string} version
 * @property {Record<string,CompilerArtifact>} [artifacts]
 */

/** @typedef {object} CompilerAssetResult
 * @property {string} name
 * @property {string} version
 * @property {string} clang
 * @property {string|null} [ld]
 * @property {'downloaded'|'cache-hit'} cache
 */

export class CompilerAssetManager {
  /** @param {{storage: import('./sdk.js').SdkStorage,fetch?:typeof fetch,progress?: (event:{name:string,status:string,received:number,total:number})=>void}} options */
  constructor(options) {
    if (!options.storage) throw new Error('A persistent compiler storage adapter is required');
    this.storage = options.storage;
    this.fetch = options.fetch ?? fetch;
    this.progress = options.progress;
    /** @type {Map<string,Promise<CompilerAssetResult>>} */
    this.pending = new Map();
  }

  /**
   * @param {CompilerAssetManifest} manifest
   * @param {{mirrorIndex?:number,localSources?:Record<string,string>,offline?:boolean}} [options]
   * @returns {Promise<CompilerAssetResult>}
   */
  async ensure(manifest, options = {}) {
    if (!manifest.artifacts?.clang) throw new Error(`Compiler '${manifest.name}' has no clang artifact`);

    const key = `${manifest.name}@${manifest.version}`;
    const pending = this.pending.get(key);
    if (pending) return pending;

    const promise = /** @type {Promise<CompilerAssetResult>} */ (this.ensureUncached(manifest, options));
    this.pending.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(key);
    }
  }

  /**
   * @param {CompilerAssetManifest} manifest
   * @param {{mirrorIndex?:number,localSources?:Record<string,string>,offline?:boolean}} [options]
   * @returns {Promise<CompilerAssetResult>}
   */
  async ensureUncached(manifest, options = {}) {
    const artifacts = manifest.artifacts;
    if (!artifacts?.clang) throw new Error(`Compiler '${manifest.name}' has no clang artifact`);
    const cacheRoot = `compilers/${manifest.name}/${manifest.version}`;
    const clangArtifact = artifacts.clang;
    const ldArtifact = artifacts.ld;
    const clangPath = `${cacheRoot}/${clangArtifact.filename}`;
    const ldPath = ldArtifact ? `${cacheRoot}/${ldArtifact.filename}` : null;

    const markerPath = `${cacheRoot}/package.json`;
    if (await this.storage.exists(markerPath) && await this.storage.exists(clangPath) && (!ldPath || await this.storage.exists(ldPath))) {
      try {
        const marker = JSON.parse(await this.storage.readText(markerPath));
        if (marker.name === manifest.name && marker.version === manifest.version) {
          const clangBytes = await this.storage.readBytes(clangPath);
          if (!clangArtifact.uncompressedSha256 || await sha256Bytes(clangBytes) === clangArtifact.uncompressedSha256) {
            if (!ldArtifact || !ldPath || await this.fileMatches(ldPath, ldArtifact.uncompressedSha256)) {
              return { name: manifest.name, version: manifest.version, clang: clangPath, ld: ldPath, cache: 'cache-hit' };
            }
          }
        }
      } catch {
        await this.storage.remove(cacheRoot);
      }
    }

    if (options.offline) {
      throw new Error(`Compiler '${manifest.name}@${manifest.version}' is not present in the local cache and offline mode is enabled`);
    }

    await this.storage.mkdir(cacheRoot);
    await this.installArtifact(cacheRoot, 'clang', clangArtifact, options);
    if (ldArtifact) await this.installArtifact(cacheRoot, 'ld', ldArtifact, options);

    await this.storage.writeText(markerPath, `${JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      clang: clangArtifact.filename,
      ld: ldArtifact?.filename ?? null,
      uncompressedSha256: clangArtifact.uncompressedSha256 ?? null,
      source: clangArtifact.url
    }, null, 2)}\n`);

    return { name: manifest.name, version: manifest.version, clang: clangPath, ld: ldPath, cache: 'downloaded' };
  }

  /** @param {string} path @param {string|null} [sha256] */
  async fileMatches(path, sha256) {
    if (!sha256) return true;
    return await sha256Bytes(await this.storage.readBytes(path)) === sha256;
  }

  /** @param {string} cacheRoot @param {string} name @param {CompilerArtifact} artifact @param {{mirrorIndex?:number,localSources?:Record<string,string>}} options */
  async installArtifact(cacheRoot, name, artifact, options) {
    const targetPath = `${cacheRoot}/${artifact.filename}`;
    if (await this.storage.exists(targetPath)) {
      const bytes = await this.storage.readBytes(targetPath);
      if (!artifact.uncompressedSha256 || await sha256Bytes(bytes) === artifact.uncompressedSha256) return;
      await this.storage.remove(targetPath);
    }

    /** @type {string[]} */
    const urls = [];
    if (typeof artifact.url === 'string' && artifact.url.length > 0) urls.push(artifact.url);
    for (const mirror of artifact.mirrors ?? []) {
      if (typeof mirror === 'string' && mirror.length > 0) urls.push(mirror);
    }
    const localSource = options.localSources?.[name];
    let lastError;

    if (localSource) urls.unshift(localSource);

    if (urls.length === 0) {
      throw new Error(`Compiler artifact '${name}' has no URL or local source. Configure an immutable release or HTTP fixture first.`);
    }

    for (const url of urls) {
      let lastDownloadError;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
          const bytes = /^file:\/\//.test(url)
            ? await readLocalFileUrl(url)
            : await downloadBytes(url, this.fetch, this.progress, name);
          let decompressed = bytes;
          if (artifact.compression) {
            decompressed = await decompressBytes(bytes, artifact.compression);
          }
          if (artifact.sha256 && await sha256Bytes(bytes) !== artifact.sha256) {
            throw new Error(`Archive SHA-256 mismatch for compiler '${name}'`);
          }
          if (artifact.uncompressedSha256 && await sha256Bytes(decompressed) !== artifact.uncompressedSha256) {
            throw new Error(`WASM SHA-256 mismatch for compiler '${name}'`);
          }
          await this.storage.writeBytes(targetPath, decompressed);
          return;
        } catch (error) {
          lastDownloadError = error;
        }
      }
      lastError = lastDownloadError;
    }

    throw new Error(`Compiler artifact '${name}' could not be installed after mirror and retry attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
}

/** @param {string} url @param {typeof fetch} fetchImpl @param {((event:{name:string,status:string,received:number,total:number})=>void)|undefined} progress @param {string} name */
const downloadBytes = async (url, fetchImpl, progress, name) => {
  let response;
  try {
    response = await fetchImpl(url, { headers: { accept: 'application/octet-stream' } });
  } catch (error) {
    throw new Error(`Download failed for compiler '${name}' at ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`Download failed (${response.status}) for compiler '${name}' at ${url}`);

  const total = Number(response.headers.get('content-length') ?? '0') || 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
      received += result.value.byteLength;
      progress?.({ name, status: 'downloading', received, total });
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    progress?.({ name, status: 'complete', received, total });
    return bytes;
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  progress?.({ name, status: 'complete', received: bytes.byteLength, total: total || bytes.byteLength });
  return bytes;
};

/** @param {string} url */
const readLocalFileUrl = async (url) => {
  const { readFile } = await import('node:fs/promises');
  return new Uint8Array(await readFile(new URL(url)));
};

/** @param {Uint8Array} bytes @param {'br'|'gzip'|'deflate'} compression */
const decompressBytes = async (bytes, compression) => {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error(`Compressed compiler '${compression}' assets require DecompressionStream support in this runtime`);
  }
  const copy = Uint8Array.from(bytes);
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream(/** @type {any} */ (compression)));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/** @param {Uint8Array} bytes */
export const sha256Bytes = async (bytes) => {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 support is unavailable in this host');
  const source = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(source).set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', source);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};
