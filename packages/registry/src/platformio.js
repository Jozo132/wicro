/** @typedef {object} PlatformIoPackage @property {string} name @property {string} owner @property {string} type @property {string} version @property {string} [url] */

export class PlatformIoRegistry {
  /** @param {{baseUrl?:string,fetch?:typeof fetch}} [options] */
  constructor(options = {}) {
    this.baseUrl = options.baseUrl ?? 'https://api.registry.platformio.org/v3';
    this.fetch = options.fetch ?? fetch;
  }

  /** @param {string} query @param {number} [limit] */
  async search(query, limit = 20) {
    if (!query.trim()) throw new Error('A PlatformIO search query is required');
    const url = `${this.baseUrl}/search?q=${encodeURIComponent(query)}&page=1&limit=${Math.max(1, limit)}`;
    const response = await this.fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`PlatformIO registry search failed (${response.status})`);
    const value = await response.json();
    const items = Array.isArray(value?.items) ? value.items : [];
    return items.map((/** @type {any} */ item) => ({
      name: typeof item.name === 'string' ? item.name : '',
      owner: typeof item.ownername === 'string' ? item.ownername : '',
      type: typeof item.type === 'string' ? item.type : 'library',
      version: typeof item.version === 'string' ? item.version : '',
      url: typeof item.url === 'string' ? item.url : undefined
    }));
  }

  /** @param {string} owner @param {string} type @param {string} name */
  async get(owner, type, name) {
    const url = `${this.baseUrl}/packages/${encodeURIComponent(owner)}/${encodeURIComponent(type)}/${encodeURIComponent(name)}`;
    const response = await this.fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`PlatformIO package lookup failed (${response.status})`);
    const value = await response.json();
    return /** @type {PlatformIoPackage} */ ({
      name: typeof value.name === 'string' ? value.name : name,
      owner,
      type,
      version: typeof value.version === 'string' ? value.version : '0.0.0',
      url: typeof value.url === 'string' ? value.url : undefined
    });
  }
}
