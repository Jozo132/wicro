/** @typedef {{name:string,status:string,received:number,total:number,bytesPerSecond?:number,etaSeconds?:number|null,resumable?:boolean}} DownloadProgress */

export class DownloadControl {
  constructor() {
    this.state = 'running';
    /** @type {AbortController|null} */ this.active = null;
    /** @type {Set<()=>void>} */ this.listeners = new Set();
  }
  pause() { if (this.state !== 'cancelled') { this.state = 'paused'; this.active?.abort(new DOMException('Download paused', 'PauseError')); this.changed(); } }
  resume() { if (this.state !== 'cancelled') { this.state = 'running'; this.changed(); } }
  cancel() { this.state = 'cancelled'; this.active?.abort(); this.changed(); }
  changed() { for (const listener of this.listeners) listener(); }
  check() { if (this.state === 'cancelled') throw new DOMException('Download cancelled', 'AbortError'); }
  async wait() {
    this.check();
    if (this.state !== 'paused') return;
    await new Promise((resolve, reject) => {
      const listener = () => {
        if (this.state === 'paused') return;
        this.listeners.delete(listener);
        try { this.check(); resolve(undefined); } catch (error) { reject(error); }
      };
      this.listeners.add(listener);
    });
  }
}

/** Fetch a public artifact with bounded inactivity, throttled progress and optional
 * in-session pause/resume. Retained bytes are reused only with a strong ETag and
 * a validated HTTP 206 response; unsupported ranges restart instead of mixing data.
 * @param {string} url
 * @param {{fetch?:typeof fetch,name?:string,progress?:(event:DownloadProgress)=>void,control?:DownloadControl,inactivityTimeoutMs?:number}} [options]
 * @returns {Promise<Uint8Array>}
 */
export const downloadBytes = async (url, options = {}) => {
  const control = options.control ?? new DownloadControl(), name = options.name ?? url;
  /** @type {Uint8Array[]} */ let chunks = [];
  let received = 0, total = 0, etag = '', rangeSupported = false, activeMs = 0, lastProgress = 0, started = 0;
  const progress = (/** @type {string} */ status, force = false) => {
    const now = Date.now();
    if (!force && now - lastProgress < 200) return;
    lastProgress = now;
    const elapsed = activeMs + (started ? now - started : 0), rate = elapsed > 0 ? received / (elapsed / 1000) : 0;
    options.progress?.({ name, status, received, total, bytesPerSecond: rate, etaSeconds: total > received && rate > 0 ? (total - received) / rate : null, resumable: Boolean(etag && rangeSupported) });
  };
  const changed = () => progress(control.state, true);
  control.listeners.add(changed);
  try {
    for (;;) {
      await control.wait();
      const controller = new AbortController(); control.active = controller;
      /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
      const touch = () => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new Error('Download inactivity timeout')), options.inactivityTimeoutMs ?? 120000);
      };
      started = Date.now(); touch();
      /** @type {number} */
      const offset = etag && rangeSupported ? received : 0;
      if (!offset && received) { chunks = []; received = 0; activeMs = 0; progress('restarting', true); }
      /** @type {ReadableStreamDefaultReader<Uint8Array>|undefined} */ let reader;
      try {
        control.check();
        /** @type {Response} */
        const response = await (options.fetch ?? fetch)(url, {
          mode: 'cors', credentials: 'omit', redirect: 'follow', signal: controller.signal,
          ...(offset ? { headers: { Range: `bytes=${offset}-`, 'If-Range': etag } } : {})
        });
        if (!response.ok || response.type === 'opaque') throw new Error(`HTTP ${response.status}`);
        const responseTag = response.headers.get('etag') ?? '';
        if (response.status === 206) {
          const match = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
          if (!offset || !match || Number(match[1]) !== offset || Number(match[2]) + 1 !== Number(match[3]) || Number(match[3]) !== total || responseTag !== etag) throw new Error('Invalid resumable response range or changed ETag');
        } else {
          if (response.status !== 200) throw new Error('Expected HTTP 200 or validated 206');
          if (offset) { chunks = []; received = 0; activeMs = 0; progress('restarting', true); }
          total = Number(response.headers.get('content-length') ?? 0) || 0;
          // Fetch may transparently decompress bodies; encoded lengths are not byte totals.
          if (response.headers.get('content-encoding')) total = 0;
          etag = /^".*"$/.test(responseTag) ? responseTag : '';
          rangeSupported = response.headers.get('accept-ranges') === 'bytes';
        }
        progress('downloading', true);
        reader = response.body?.getReader();
        if (reader) {
          for (;;) {
            const result = await reader.read(); touch(); control.check();
            if (result.done) break;
            chunks.push(result.value); received += result.value.byteLength; progress('downloading');
          }
        } else {
          const bytes = new Uint8Array(await response.arrayBuffer()); chunks.push(bytes); received += bytes.length;
        }
        if (control.state === 'paused') continue;
        if (total && received !== total) throw new Error('Incomplete download body');
        const bytes = new Uint8Array(received); let at = 0;
        for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
        total ||= received; progress('complete', true); return bytes;
      } catch (error) {
        control.check();
        if (control.state === 'paused' || controller.signal.reason?.name === 'PauseError') { progress(control.state === 'paused' ? 'paused' : 'downloading', true); continue; }
        throw new Error(`Download failed at ${url}: ${error instanceof Error ? error.message : String(error)}. In browsers, check the remote server's CORS policy (Access-Control-Allow-Origin), redirects, CSP connect-src, and network access.`);
      } finally {
        clearTimeout(timer); activeMs += Date.now() - started; started = 0;
        if (controller.signal.aborted) await reader?.cancel().catch(() => {});
        reader?.releaseLock(); control.active = null;
      }
    }
  } finally { control.listeners.delete(changed); }
};
