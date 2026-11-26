/** Read-only public artifact relay. Validate every redirect; forward no cookies,
 * authorization or arbitrary request headers. No SDK archives are stored here.
 */
const hosts = new Set(['dl.registry.platformio.org', 'github.com', 'codeload.github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
/** @param {URL} url */
const allowed = (url) => url.protocol === 'https:' && (!url.port || url.port === '443') && !url.username && !url.password && hosts.has(url.hostname) && (
  url.hostname === 'dl.registry.platformio.org' ? url.pathname.startsWith('/download/') :
  url.hostname === 'github.com' ? /^\/[^/]+\/[^/]+\/(?:releases\/download|archive)\//i.test(url.pathname) :
  url.hostname === 'codeload.github.com' ? /^\/[^/]+\/[^/]+\/(?:legacy\.zip|zip|tar\.gz)\//i.test(url.pathname) :
  url.hostname === 'raw.githubusercontent.com' ? /^\/[^/]+\/[^/]+\//.test(url.pathname) :
  url.hostname === 'objects.githubusercontent.com' ? /^\/github-production-release-asset-/.test(url.pathname) : url.pathname.startsWith('/github-production-release-asset/')
);
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Range, If-Range', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified' };
/** @param {string} message @param {number} status */
const errorResponse = (message, status) => new Response(message, { status, headers: { ...cors, 'Content-Type': 'text/plain; charset=utf-8' } });

/** @param {Request} request @param {{fetch?:typeof fetch}} [options] */
export const relayArtifact = async (request, options = {}) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!['GET', 'HEAD'].includes(request.method)) return errorResponse('Method not allowed', 405);
  let url;
  try { const value = new URL(request.url).searchParams.get('url'); if (!value) return errorResponse('Missing url parameter', 400); url = new URL(value); }
  catch { return errorResponse('Invalid target URL', 400); }
  const headers = new Headers();
  for (const name of ['Range', 'If-Range']) { const value = request.headers.get(name); if (value) headers.set(name, value); }
  for (let hop = 0; hop < 6; hop++) {
    if (!allowed(url)) return errorResponse('Artifact origin/path not allowlisted', 403);
    const response = await (options.fetch ?? fetch)(url, { method: request.method, headers, redirect: 'manual', signal: request.signal, credentials: 'omit' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) return errorResponse('Missing upstream redirect target', 502);
      url = new URL(location, url); continue;
    }
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > 512 * 1024 * 1024) { await response.body?.cancel(); return errorResponse('Artifact exceeds 512 MiB limit', 413); }
    const out = new Headers(cors);
    for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified', 'Cache-Control']) { const value = response.headers.get(name); if (value) out.set(name, value); }
    if (response.headers.has('content-encoding')) { out.delete('Content-Length'); out.delete('Accept-Ranges'); out.delete('ETag'); }
    let received = 0;
    const bounded = response.body?.pipeThrough(new TransformStream({ transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > 512 * 1024 * 1024) { controller.error(new Error('Artifact exceeds 512 MiB limit')); return; }
      controller.enqueue(chunk);
    } }));
    return new Response(request.method === 'HEAD' ? null : bounded, { status: response.status, headers: out });
  }
  return errorResponse('Too many artifact redirects', 508);
};

export default { fetch: async (/** @type {Request} */ request) => {
  try { return await relayArtifact(request); }
  catch (error) { return errorResponse(error instanceof Error ? error.message : 'Upstream artifact request failed', 502); }
} };
