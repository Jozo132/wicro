/** @param {string} path */
const normalizePath = (path) => {
  if (typeof path !== 'string' || path.length === 0) throw new Error('A path is required');

  const parts = path.replace(/\\/g, '/').split('/');
  const normalized = [];

  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (normalized.length === 0) throw new Error(`Path escapes the filesystem root: ${path}`);
      normalized.pop();
    } else {
      normalized.push(part);
    }
  }

  return `/${normalized.join('/')}`;
};

export class MemoryFilesystem {
  constructor() {
    /** @type {Map<string, string|Uint8Array>} */
    this.files = new Map();
    /** @type {Set<string>} */
    this.directories = new Set(['/']);
  }

  /** @param {string} path */
  async exists(path) {
    const normalized = normalizePath(path);
    return this.files.has(normalized) || this.directories.has(normalized);
  }

  /** @param {string} path */
  async readFile(path) {
    const normalized = normalizePath(path);
    const value = this.files.get(normalized);
    if (value === undefined) throw new Error(`File not found: ${normalized}`);
    return value;
  }

  /** @param {string} path @param {string|Uint8Array} data */
  async writeFile(path, data) {
    const normalized = normalizePath(path);
    const separator = normalized.lastIndexOf('/');
    const parent = separator === 0 ? '/' : normalized.slice(0, separator);
    await this.mkdir(parent);
    this.files.set(normalized, data);
  }

  /** @param {string} path */
  async mkdir(path) {
    const normalized = normalizePath(path);
    const parts = normalized === '/' ? [] : normalized.slice(1).split('/');
    let current = '';
    this.directories.add('/');

    for (const part of parts) {
      current += `/${part}`;
      this.directories.add(current);
    }
  }

  /** @param {string} path */
  async readdir(path) {
    const normalized = normalizePath(path);
    if (!this.directories.has(normalized)) throw new Error(`Directory not found: ${normalized}`);

    const prefix = normalized === '/' ? '/' : `${normalized}/`;
    const names = new Set();

    for (const name of this.directories) {
      if (name === '/' || name === normalized || !name.startsWith(prefix)) continue;
      const remainder = name.slice(prefix.length);
      if (remainder && !remainder.includes('/')) names.add(remainder);
    }

    for (const name of this.files.keys()) {
      if (!name.startsWith(prefix)) continue;
      const remainder = name.slice(prefix.length);
      if (remainder && !remainder.includes('/')) names.add(remainder);
    }

    return [...names].sort();
  }

  /** @param {string} path */
  async remove(path) {
    const normalized = normalizePath(path);
    for (const file of [...this.files.keys()]) {
      if (file === normalized || file.startsWith(`${normalized}/`)) {
        this.files.delete(file);
      }
    }

    for (const directory of [...this.directories]) {
      if (directory === normalized || directory.startsWith(`${normalized}/`)) {
        this.directories.delete(directory);
      }
    }
  }
}
