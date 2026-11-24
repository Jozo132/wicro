/**
 * Resolve official PlatformIO redirect metadata without transferring archive bytes.
 * The restricted origin/path prevents this endpoint becoming a general proxy.
 * @param {string} value
 */
export const resolvePlatformIoDownload = async (value) => {
  const url = new URL(value);
  if (url.origin !== 'https://dl.registry.platformio.org' || !url.pathname.startsWith('/download/') || url.username || url.password) throw new Error('Only official PlatformIO /download/ metadata URLs are accepted');
  const response = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(20000) });
  const location = response.headers.get('location');
  if (![301, 302, 303, 307, 308].includes(response.status) || !location) throw new Error(`PlatformIO download metadata did not provide a redirect (HTTP ${response.status})`);
  const resolved = new URL(location, url);
  if (resolved.origin !== 'https://dl.registry.platformio.org' || !resolved.pathname.startsWith('/libraries/')) throw new Error('PlatformIO returned an unsupported library CDN destination');
  return resolved.href;
};
