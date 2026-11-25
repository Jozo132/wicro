import { Gunzip, zipSync } from 'fflate';
import { safeLibraryPath } from './library-archive.js';
import { downloadBytes } from './download.js';
import { sha256Bytes } from './sdk.js';

/** @typedef {{prefix:string,to:string,files?:string[]}} SelectionRule */
/** @typedef {{name:string,url:string,sha256:string,rules?:SelectionRule[],format?:'github-blob',output?:string}} CompositionSource */

/** Stream TAR.GZ through a path filter without retaining host compiler executables
 * or the complete uncompressed archive. Selected links are rejected.
 * @param {Uint8Array} archive @param {SelectionRule[]} rules
 * @returns {Record<string,Uint8Array>}
 */
export const selectTarGzip = (archive, rules) => {
  if (archive.length < 18 || archive[0] !== 0x1f || archive[1] !== 0x8b || archive[2] !== 8) throw new Error('Invalid SDK gzip archive');
  const decoder = new TextDecoder();
  const text = (/** @type {Uint8Array} */ bytes) => decoder.decode(bytes).replace(/\0.*$/s, '');
  /** @type {Record<string,Uint8Array>} */ const files = Object.create(null);
  const header = new Uint8Array(512);
  let headerUsed = 0, remaining = 0, padding = 0, size = 0, at = 0, total = 0, decodedLength = 0, ended = false;
  let type = '', output = '', longName = '', metadata = false;
  /** @type {Uint8Array|null} */ let data = null;
  const finish = () => {
    if (metadata && data) {
      if (type === 'L') longName = text(data).replace(/\n$/, '');
      if (type === 'x') for (const record of decoder.decode(data).split('\n')) { const match = record.match(/^\d+ path=(.+)$/); if (match) longName = match[1]; }
    } else if (output && data) {
      if (files[output]) throw new Error(`Duplicate SDK member ${output}`);
      files[output] = data;
    }
    data = null;
  };
  const gunzip = new Gunzip((chunk) => {
    decodedLength += chunk.length;
    for (let offset = 0; offset < chunk.length;) {
      if (ended) return;
      if (remaining) {
        const count = Math.min(remaining, chunk.length - offset);
        if (data) data.set(chunk.subarray(offset, offset + count), at);
        offset += count; at += count; remaining -= count;
        if (!remaining) finish();
        continue;
      }
      if (padding) { const count = Math.min(padding, chunk.length - offset); padding -= count; offset += count; continue; }
      const count = Math.min(512 - headerUsed, chunk.length - offset);
      header.set(chunk.subarray(offset, offset + count), headerUsed); headerUsed += count; offset += count;
      if (headerUsed !== 512) continue;
      headerUsed = 0;
      if (header.every((byte) => byte === 0)) { ended = true; return; }
      const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
      if (Number.parseInt(text(header.subarray(148, 156)).trim(), 8) !== checksum) throw new Error('SDK TAR header checksum mismatch');
      size = Number.parseInt(text(header.subarray(124, 136)).trim() || '0', 8);
      if (!Number.isSafeInteger(size) || size < 0 || size > 0x80000000) throw new Error('Invalid SDK TAR size');
      type = String.fromCharCode(header[156]); metadata = ['L', 'x'].includes(type);
      const prefix = text(header.subarray(345, 500));
      const raw = longName || `${prefix ? prefix + '/' : ''}${text(header.subarray(0, 100))}`;
      if (!metadata) longName = '';
      output = '';
      if (!(type === '5' && /^\.?\/?$/.test(raw))) {
        const name = safeLibraryPath(raw);
        for (const rule of rules) if (name.startsWith(rule.prefix) && (!rule.files || rule.files.includes(name.slice(rule.prefix.length)))) {
          output = safeLibraryPath(rule.to + name.slice(rule.prefix.length)); break;
        }
      }
      if (output && !['0', '\0', '5'].includes(type)) throw new Error(`Selected SDK member is not a regular file: ${raw}`);
      if (type === '5') output = '';
      if (metadata && size > 1048576 || output && size > 64 * 1024 * 1024) throw new Error('SDK TAR member exceeds its extraction limit');
      total += output ? size : 0;
      if (total > 256 * 1024 * 1024) throw new Error('Selected SDK exceeds 256 MiB');
      data = output || metadata ? new Uint8Array(size) : null;
      remaining = size; padding = (512 - size % 512) % 512; at = 0;
      if (!size) finish();
    }
  });
  for (let at = 0; at < archive.length; at += 65536) gunzip.push(archive.subarray(at, at + 65536), at + 65536 >= archive.length);
  if (new DataView(archive.buffer, archive.byteOffset + archive.length - 4, 4).getUint32(0, true) !== (decodedLength >>> 0)) throw new Error('Truncated SDK gzip payload');
  if (!ended || remaining || headerUsed) throw new Error('Truncated SDK TAR archive');
  if (!Object.keys(files).length) throw new Error('SDK selection is empty');
  return files;
};

/** @param {Record<string,Uint8Array>} files */
export const finishSdkComposition = (files) => {
  const sources = Object.keys(files).filter((name) => /^framework\/(cores\/arduino|libraries\/(SrcWrapper|USBDevice))\/.*\.(c|cpp)$/.test(name)).sort();
  files['sources.json'] = new TextEncoder().encode(JSON.stringify(sources));
  files['inventory.json'] = new TextEncoder().encode(JSON.stringify(Object.keys(files).sort()));
  return zipSync(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)), { level: 6, mtime: new Date(1980, 0, 1) });
};

/** @param {{sources:CompositionSource[]}} composition
 * @param {{storage:import('./sdk.js').SdkStorage,fetch?:typeof fetch,control?:import('./download.js').DownloadControl,progress?:(event:import('./download.js').DownloadProgress)=>void,resolveUrl?:(url:string)=>string}} options
 */
export const composeSdkArchive = async (composition, options) => {
  /** @type {Record<string,Uint8Array>} */ const files = Object.create(null);
  for (const source of composition.sources) {
    if (!/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error('Composition source requires trusted SHA-256');
    const cache = `upstreams/${source.sha256}.artifact`;
    /** @type {Uint8Array|undefined} */ let bytes;
    if (await options.storage.exists(cache)) {
      const stored = await options.storage.readBytes(cache);
      if (await sha256Bytes(stored) === source.sha256) bytes = stored;
      else await options.storage.remove(cache);
    }
    if (!bytes) {
      bytes = await downloadBytes(options.resolveUrl?.(source.url) ?? source.url, { fetch: options.fetch, control: options.control, progress: options.progress, name: source.name });
      if (source.format === 'github-blob') {
        const blob = JSON.parse(new TextDecoder().decode(bytes));
        if (blob.encoding !== 'base64' || typeof blob.content !== 'string' || blob.size > 1048576) throw new Error('Invalid compiler header blob');
        bytes = Uint8Array.from(atob(blob.content.replace(/\s/g, '')), (character) => character.charCodeAt(0));
      }
      if (await sha256Bytes(bytes) !== source.sha256) throw new Error(`SDK upstream checksum mismatch: ${source.name}`);
      await options.storage.mkdir('upstreams'); await options.storage.writeBytes(cache, bytes);
    }
    const selected = source.format === 'github-blob' && source.output ? { [safeLibraryPath(source.output)]: bytes } : selectTarGzip(bytes, source.rules ?? []);
    for (const [name, value] of Object.entries(selected)) {
      if (files[name]) throw new Error(`SDK composition collision: ${name}`);
      files[name] = value;
    }
  }
  return finishSdkComposition(files);
};
