import { gunzipSync } from 'fflate';
import { coerce, rcompare, satisfies, valid } from 'semver';
import { downloadBytes } from './download.js';
import { sha256Bytes } from './sdk.js';

/** @typedef {{provider:'arduino'|'platformio'|'files'|'archive',name:string,version?:string,owner?:string,url?:string,sha256?:string,archiveType?:'zip'|'tar.gz'}} LibraryRequest */
/** @typedef {{id:string,provider:LibraryRequest['provider'],name:string,owner?:string,version:string,description?:string,license?:string,architectures?:string[],url?:string,sha256:string,archiveType?:'zip'|'tar.gz',files?:Record<string,{url:string,sha256:string}>,dependencies?:Array<{name:string,version?:string,owner?:string}>}} LibraryRelease */

/** Preserve upstream labels such as PlatformIO 2.8, while comparing as SemVer. @param {string} value */
export const librarySemver = (value) => valid(value) ?? (/^\d+(?:\.\d+){0,2}$/.test(value) ? coerce(value)?.version ?? null : null);

export class LibraryCatalog {
  /** @param {{storage:import('./sdk.js').SdkStorage,fetch?:typeof fetch,arduinoIndexUrl?:string,platformioBaseUrl?:string,offline?:boolean}} options */
  constructor(options) {
    this.storage = options.storage;
    this.fetch = options.fetch ?? fetch;
    this.arduinoIndexUrl = options.arduinoIndexUrl ?? 'https://downloads.arduino.cc/libraries/library_index.json.gz';
    this.platformioBaseUrl = options.platformioBaseUrl ?? 'https://api.registry.platformio.org/v3';
    this.offline = options.offline ?? false;
    /** @type {Map<string,any>} */
    this.memory = new Map();
  }

  /** @param {string} url @param {boolean} [refresh] @returns {Promise<any>} */
  async json(url, refresh = false) {
    if (!refresh && this.memory.has(url)) return this.memory.get(url);
    const path = `library-catalog/${await sha256Bytes(new TextEncoder().encode(url))}.json`;
    let text;
    if ((!refresh || this.offline) && await this.storage.exists(path)) text = await this.storage.readText(path);
    else {
      if (this.offline) throw new Error('Library catalog is not cached; connect once before using offline search');
      const bytes = await downloadBytes(url, { fetch: this.fetch });
      text = new TextDecoder().decode(bytes[0] === 31 && bytes[1] === 139 ? gunzipSync(bytes) : bytes);
      JSON.parse(text);
      await this.storage.writeText(path, text);
    }
    const value = JSON.parse(text);
    this.memory.set(url, value);
    return value;
  }

  /** @param {'arduino'|'platformio'} provider @param {string} query @param {boolean} [refresh] @returns {Promise<LibraryRelease[]>} */
  async search(provider, query, refresh = false) {
    if (!query.trim()) throw new Error('Enter a library name or search term');
    if (provider === 'arduino') {
      const index = await this.json(this.arduinoIndexUrl, refresh);
      /** @type {Map<string,LibraryRelease>} */
      const latest = new Map();
      for (const entry of index.libraries ?? []) {
        if (!librarySemver(entry.version) || !`${entry.name} ${entry.sentence ?? ''}`.toLowerCase().includes(query.toLowerCase())) continue;
        const release = arduinoRelease(entry);
        if (!latest.has(release.name) || rcompare(/** @type {string} */ (librarySemver(release.version)), /** @type {string} */ (librarySemver(/** @type {LibraryRelease} */ (latest.get(release.name)).version))) < 0) latest.set(release.name, release);
      }
      return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 50);
    }
    const data = await this.json(`${this.platformioBaseUrl}/search?query=${encodeURIComponent(`type:library ${query}`)}&page=1&limit=30`, refresh);
    return (data.items ?? []).filter((/** @type {any} */ item) => item.type === 'library').map(platformioRelease);
  }

  /** @param {LibraryRequest} request @returns {Promise<LibraryRelease>} */
  async resolve(request) {
    if (request.provider === 'archive') {
      if (!request.url || !request.sha256 || !request.version) throw new Error('Archive libraries require an exact version, URL and SHA-256');
      return { ...request, id: `archive/${request.name}`, version: request.version, sha256: request.sha256, archiveType: request.archiveType ?? 'zip' };
    }
    if (request.provider === 'arduino') {
      const index = await this.json(this.arduinoIndexUrl);
      const entries = (index.libraries ?? []).filter((/** @type {any} */ entry) => entry.name === request.name && librarySemver(entry.version) && satisfies(/** @type {string} */ (librarySemver(entry.version)), request.version ?? '*')).sort((/** @type {any} */ a, /** @type {any} */ b) => rcompare(librarySemver(a.version) ?? a.version, librarySemver(b.version) ?? b.version));
      if (!entries.length) throw new Error(`Arduino library not found: ${request.name}@${request.version ?? '*'}`);
      return arduinoRelease(entries[0]);
    }
    if (request.provider !== 'platformio') throw new Error(`Unsupported library provider: ${request.provider}`);
    let owner = request.owner;
    let name = request.name;
    if (!owner && name.includes('/')) [owner, name] = name.split('/', 2);
    if (!owner) {
      const matches = (await this.search('platformio', `name:"${name}"`)).filter((entry) => entry.name.toLowerCase() === name.toLowerCase());
      if (matches.length !== 1) throw new Error(`PlatformIO library '${name}' is missing or ambiguous; specify its owner/name`);
      owner = matches[0].owner;
    }
    const data = await this.json(`${this.platformioBaseUrl}/packages/${encodeURIComponent(String(owner))}/library/${encodeURIComponent(name)}`);
    const versions = (data.versions ?? [data.version]).filter((/** @type {any} */ entry) => entry && librarySemver(entry.name) && satisfies(/** @type {string} */ (librarySemver(entry.name)), request.version ?? '*')).sort((/** @type {any} */ a, /** @type {any} */ b) => rcompare(librarySemver(a.name) ?? a.name, librarySemver(b.name) ?? b.name));
    if (!versions.length) throw new Error(`PlatformIO library not found: ${owner}/${name}@${request.version ?? '*'}`);
    return platformioRelease({ ...data, version: versions[0] });
  }
}

/** @param {any} entry @returns {LibraryRelease} */
const arduinoRelease = (entry) => ({
  id: `arduino/${entry.name}`, provider: 'arduino', name: entry.name, version: entry.version,
  description: entry.sentence ?? '', license: entry.license ?? '', architectures: entry.architectures ?? ['*'],
  url: entry.url, sha256: String(entry.checksum ?? '').replace(/^SHA-256:/i, '').toLowerCase(), archiveType: 'zip', dependencies: entry.dependencies ?? []
});

/** @param {any} entry @returns {LibraryRelease} */
const platformioRelease = (entry) => {
  const file = entry.version?.files?.find((/** @type {any} */ file) => file.system === '*') ?? entry.version?.files?.[0];
  const owner = entry.owner?.username ?? entry.ownername;
  return {
    id: `platformio/${owner}/${entry.name}`, provider: 'platformio', owner, name: entry.name,
    version: entry.version?.name ?? entry.version, description: entry.description ?? '', license: entry.license ?? '',
    url: file?.download_url, sha256: file?.checksum?.sha256 ?? '', archiveType: 'tar.gz'
  };
};
