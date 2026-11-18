import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';

/** @typedef {object} InstallOptions @property {string} [name] @property {string} [sha256] @property {string} [cacheDirectory] */

/** @param {string} name */
export const safeArchivePath = (name) => {
  const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('../')) {
    throw new Error(`Unsafe archive path: ${name}`);
  }
  return normalized;
};

export class PackageInstaller {
  /** @param {{files?: import('../../filesystem/src/index.js').MemoryFilesystem}} [options] */
  constructor(options = {}) {
    this.files = options.files;
  }

  /** @param {string} source @param {InstallOptions} [options] */
  async install(source, options = {}) {
    if (source.startsWith('http://') || source.startsWith('https://')) {
      return this.installUrl(source, options);
    }

    if (source.startsWith('file://')) {
      return this.installLocal(new URL(source).pathname, options);
    }

    return this.installLocal(resolve(source), options);
  }

  /** @param {string} url @param {InstallOptions} [options] */
  async installUrl(url, options = {}) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Package download failed (${response.status}): ${url}`);

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (options.sha256) verifySha256(bytes, options.sha256);

    if (isZip(bytes)) return this.installZip(bytes, options);

    throw new Error('Only ZIP package archives are supported for URL installation');
  }

  /** @param {Uint8Array} bytes @param {InstallOptions} [options] */
  async installZip(bytes, options = {}) {
    const entries = unzipSync(bytes);
    const installed = [];

    for (const [rawName, data] of Object.entries(entries)) {
      const name = safeArchivePath(rawName);
      if (rawName.endsWith('/') || rawName.endsWith('\\')) continue;

      if (this.files) await this.files.writeFile(`/${options.name ?? 'packages'}/${name}`, data);
      installed.push(name);
    }

    return { ok: true, kind: 'zip', count: installed.length, files: installed };
  }

  /** @param {string} directory @param {InstallOptions} [options] */
  async installLocal(directory, options = {}) {
    const source = resolve(directory);
    const details = await stat(source);
    if (!details.isDirectory()) throw new Error(`Package source is not a directory: ${source}`);

    const target = options.cacheDirectory
      ? resolve(options.cacheDirectory, options.name ?? 'package')
      : resolve('.wicro/packages', options.name ?? 'package');
    await mkdir(target, { recursive: true });
    await cp(source, target, { recursive: true, dereference: true, preserveTimestamps: true });

    return { ok: true, kind: 'directory', source, target };
  }
}

/** @param {Uint8Array} bytes @param {string} expected */
export const verifySha256 = (bytes, expected) => {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected.toLowerCase()) {
    throw new Error(`SHA-256 mismatch: expected ${expected.toLowerCase()}, got ${actual}`);
  }
};

/** @param {Uint8Array} bytes */
export const isZip = (bytes) => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
