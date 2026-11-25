import { composeSdkArchive } from '../../packages/registry/src/sdk-composition.js';
import { BrowserSdkStorage } from '../../packages/registry/src/browser-cache.js';
import { sha256Bytes } from '../../packages/registry/src/sdk.js';

self.addEventListener('message', async (event) => {
  try {
    const { manifests, urls } = event.data;
    const storage = new BrowserSdkStorage(); let downloads = 0;
    const results = [];
    for (let index = 0; index < manifests.length; index++) {
      const manifest = manifests[index];
      const archive = await composeSdkArchive(manifest.metadata.composition, {
        storage,
        resolveUrl: (url) => urls[url],
        fetch: async (url, settings) => {
          if (index > 0) throw new Error('Second family must reuse verified OPFS inputs');
          downloads++; return fetch(url, settings);
        }
      });
      results.push({ name: manifest.name, sha256: await sha256Bytes(archive), expected: manifest.metadata.distribution.sha256 });
    }
    self.postMessage({ ok: true, downloads, results });
  } catch (error) { self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});
