/** @typedef {{name:string,status:string,received:number,total:number}} DownloadProgress */

/**
 * Fetch public artifact bytes without credentials. The remote server must grant CORS
 * access in browsers; a network error cannot reliably distinguish CORS from DNS/TLS.
 * @param {string} url
 * @param {{fetch?:typeof fetch,name?:string,progress?:(event:DownloadProgress)=>void}} [options]
 * @returns {Promise<Uint8Array>}
 */
export const downloadBytes = async (url, options = {}) => {
  const name = options.name ?? url;
  let response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      mode: 'cors', credentials: 'omit', redirect: 'follow',
      signal: AbortSignal.timeout(120_000)
    });
  } catch (error) {
    throw new Error(`Download failed at ${url}: ${error instanceof Error ? error.message : String(error)}. In browsers, check the remote server's CORS policy (Access-Control-Allow-Origin), redirects, CSP connect-src, and network access. Wicro cannot grant CORS permission for another server.`);
  }
  if (!response.ok || response.type === 'opaque') {
    throw new Error(`Download failed (HTTP ${response.status}) at ${url}`);
  }
  const total = Number(response.headers.get('content-length') ?? '0') || 0;
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  /** @type {Uint8Array[]} */
  const chunks = [];
  let received = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
    received += result.value.byteLength;
    options.progress?.({ name, status: 'downloading', received, total });
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  options.progress?.({ name, status: 'complete', received, total: total || received });
  return bytes;
};
