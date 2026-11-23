import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

/** @param {string} [override] */
export const defaultWicroCacheDirectory = (override) => {
  if (override) return resolve(override);
  if (process.platform === 'linux') return resolve(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'wicro');
  if (process.platform === 'darwin') return resolve(homedir(), 'Library', 'Caches', 'wicro');
  if (process.platform === 'win32') return resolve(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'wicro');
  return resolve(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'wicro');
};

export class NodeSdkStorage {
  /** @param {{root?:string,override?:string}} [options] */
  constructor(options = {}) {
    this.root = resolve(options.root ?? defaultWicroCacheDirectory(options.override));
  }

  /** @param {string} path */
  absolute(path) {
    const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (normalized.split('/').includes('..')) throw new Error(`Unsafe cache path: ${path}`);
    return join(this.root, ...normalized.split('/'));
  }

  /** @param {string} path */
  async exists(path) {
    try {
      await stat(this.absolute(path));
      return true;
    } catch {
      return false;
    }
  }

  /** @param {string} path */
  async readText(path) {
    return readFile(this.absolute(path), 'utf8');
  }

  /** @param {string} path */
  async readBytes(path) {
    return new Uint8Array(await readFile(this.absolute(path)));
  }

  /** @param {string} path @param {string} text */
  async writeText(path, text) {
    const absolute = this.absolute(path);
    await mkdir(resolve(absolute, '..'), { recursive: true });
    const temp = `${absolute}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temp, text, 'utf8');
      await rename(temp, absolute);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  /** @param {string} path @param {Uint8Array} data */
  async writeBytes(path, data) {
    const absolute = this.absolute(path);
    await mkdir(resolve(absolute, '..'), { recursive: true });
    const temp = `${absolute}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temp, data);
      await rename(temp, absolute);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  /** @param {string} from @param {string} to */
  async rename(from, to) {
    const source = this.absolute(from);
    const target = this.absolute(to);
    await mkdir(resolve(target, '..'), { recursive: true });
    await rm(target, { recursive: true, force: true });
    await rename(source, target);
  }

  /** @param {string} path */
  async mkdir(path) {
    await mkdir(this.absolute(path), { recursive: true });
  }

  /** @param {string} path */
  async remove(path) {
    await rm(this.absolute(path), { recursive: true, force: true });
  }

  /** @param {string} path */
  async readdir(path) {
    return readdir(this.absolute(path));
  }
}
