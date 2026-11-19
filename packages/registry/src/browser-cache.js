export class BrowserSdkStorage {
  constructor() {
    /** @type {FileSystemDirectoryHandle|null} */
    this.root = null;
  }

  async initialize() {
    const storage = /** @type {any} */ (globalThis.navigator?.storage);
    if (!storage?.getDirectory) throw new Error('OPFS is unavailable in this browser host');
    if (typeof storage.persist === 'function') {
      try { await storage.persist(); } catch { /* Browser storage policy may reject persistence. */ }
    }
    this.root = await storage.getDirectory();
  }

  /** @param {string} path */
  async parts(path) {
    if (!this.root) await this.initialize();
    const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!normalized) return /** @type {FileSystemDirectoryHandle} */ (this.root);
    if (normalized.split('/').includes('..')) throw new Error(`Unsafe cache path: ${path}`);
    let directory = /** @type {FileSystemDirectoryHandle} */ (this.root);
    const segments = normalized.split('/');
    for (const segment of segments) {
      if (!segment) continue;
      directory = await directory.getDirectoryHandle(segment, { create: true });
    }
    return directory;
  }

  /** @param {string} path */
  async exists(path) {
    const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!normalized) return true;
    const segments = normalized.split('/');
    const fileName = segments.pop();
    try {
      if (!fileName) return false;
      const directory = await this.parts(segments.join('/'));
      await directory.getFileHandle(fileName);
      return true;
    } catch {
      try {
        const directory = await this.parts(normalized);
        return Boolean(directory);
      } catch {
        return false;
      }
    }
  }

  /** @param {string} path */
  async readText(path) {
    const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
    const segments = normalized.split('/');
    const fileName = segments.pop();
    if (!fileName) throw new Error(`Cache file path is required: ${path}`);
    const directory = await this.parts(segments.join('/'));
    const handle = await directory.getFileHandle(fileName);
    const file = await handle.getFile();
    return file.text();
  }

  /** @param {string} path */
  async readBytes(path) {
    const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
    const segments = normalized.split('/');
    const fileName = segments.pop();
    if (!fileName) throw new Error(`Cache file path is required: ${path}`);
    const directory = await this.parts(segments.join('/'));
    const handle = await directory.getFileHandle(fileName);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  /** @param {string} path @param {string} text */
  async writeText(path, text) {
    await this.writeBytes(path, new TextEncoder().encode(text));
  }

  /** @param {string} path @param {Uint8Array} data */
  async writeBytes(path, data) {
    const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
    const segments = normalized.split('/');
    const fileName = segments.pop();
    if (!fileName) throw new Error(`Cache file path is required: ${path}`);
    const directory = await this.parts(segments.join('/'));
    const handle = await directory.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    const copy = new ArrayBuffer(data.byteLength);
    new Uint8Array(copy).set(Array.from(data));
    await writable.write(copy);
    await writable.close();
  }

  /** @param {string} path */
  async mkdir(path) {
    await this.parts(path);
  }

  /** @param {string} path */
  async remove(path) {
    const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!normalized) return;
    const segments = normalized.split('/');
    const name = segments.pop();
    if (!name) return;
    const directory = await this.parts(segments.join('/'));
    await directory.removeEntry(name, { recursive: true });
  }

  /** @param {string} path */
  async readdir(path) {
    const directory = await this.parts(path);
    const names = [];
    for await (const entry of /** @type {any} */ (directory).values()) names.push(entry.name);
    return names.sort();
  }
}
