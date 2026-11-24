import { gunzipSync, unzipSync } from 'fflate';

/** @param {string} path */
export const safeLibraryPath = (path) => {
  const normalized = path.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').some((part) => !part || part === '..' || part === '.') || normalized.includes('\0')) throw new Error(`Unsafe library archive path: ${path}`);
  return normalized;
};

/** Decode regular-file ZIP or TAR.GZ libraries; reject links and unsafe paths. @param {Uint8Array} bytes @param {'zip'|'tar.gz'} format */
export const extractLibraryArchive = (bytes, format) => {
  /** @type {Record<string,Uint8Array>} */
  const entries = Object.create(null);
  let total = 0;
  /** @param {string} name @param {Uint8Array} data */
  const add = (name, data) => {
    const path = safeLibraryPath(name);
    total += data.byteLength;
    if (total > 128 * 1024 * 1024) throw new Error('Library archive exceeds the 128 MiB extraction limit');
    if (entries[path]) throw new Error(`Duplicate library archive path: ${path}`);
    entries[path] = data;
  };
  if (format === 'zip') {
    const files = unzipSync(bytes, { filter: (file) => {
      if (file.originalSize > 128 * 1024 * 1024) throw new Error('Library ZIP member exceeds extraction limit');
      safeLibraryPath(file.name);
      return true;
    } });
    for (const [name, data] of Object.entries(files)) if (!name.endsWith('/') && !name.endsWith('\\')) add(name, data);
  } else {
    const tar = gunzipSync(bytes);
    const decoder = new TextDecoder();
    /** @param {Uint8Array} value */
    const string = (value) => decoder.decode(value).replace(/\0.*$/s, '');
    let pendingName = '';
    for (let offset = 0; offset + 512 <= tar.length;) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) break;
      const expected = Number.parseInt(string(header.subarray(148, 156)).trim(), 8);
      const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
      if (expected !== actual) throw new Error('Invalid TAR header checksum');
      const size = Number.parseInt(string(header.subarray(124, 136)).trim() || '0', 8);
      if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Truncated or invalid TAR member');
      const type = String.fromCharCode(header[156]);
      const prefix = string(header.subarray(345, 500));
      const name = pendingName || `${prefix ? `${prefix}/` : ''}${string(header.subarray(0, 100))}`;
      const data = tar.slice(offset + 512, offset + 512 + size);
      pendingName = '';
      if (type === '0' || type === '\0') add(name, data);
      else if (type === 'L') pendingName = string(data).replace(/\n$/, '');
      else if (type === 'x') {
        for (const record of decoder.decode(data).split('\n')) {
          const match = record.match(/^\d+ path=(.+)$/);
          if (match) pendingName = match[1];
        }
      } else if (type !== '5' && type !== 'g') throw new Error(`Unsupported TAR member type '${type}' at ${name}; links are not imported`);
      offset += 512 + Math.ceil(size / 512) * 512;
    }
  }
  const names = Object.keys(entries);
  const manifests = names.filter((name) => /(^|\/)(library\.properties|library\.json)$/.test(name)).sort((a, b) => a.split('/').length - b.split('/').length);
  const manifest = manifests[0];
  if (!manifest) throw new Error('Library archive must contain library.properties or library.json');
  const prefix = manifest.slice(0, manifest.lastIndexOf('/') + 1);
  if (prefix && !names.every((name) => name.startsWith(prefix))) throw new Error('Library archive has ambiguous roots');
  return Object.fromEntries(Object.entries(entries).map(([name, data]) => [prefix ? name.slice(prefix.length) : name, data]));
};
