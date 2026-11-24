import { SdkLifecycleManager } from '../../packages/registry/src/sdk.js';
import { CompilerAssetManager } from '../../packages/registry/src/compiler-assets.js';
import { BrowserSdkStorage } from '../../packages/registry/src/browser-cache.js';
import { downloadBytes } from '../../packages/registry/src/download.js';

/** @param {{kind:string,manifest:any,offline?:boolean,url?:string}} request */
const run = async (request) => {
  if (request.kind === 'download') return [...await downloadBytes(String(request.url))];
  const storage = new BrowserSdkStorage();
  if (request.kind === 'sdk') {
    const result = await new SdkLifecycleManager({ storage }).ensure(request.manifest, { offline: request.offline });
    return { ...result, content: await storage.readText(`${result.target}/core/Arduino.h`) };
  }
  const result = await new CompilerAssetManager({ storage }).ensure(request.manifest, { offline: request.offline });
  await WebAssembly.compile(Uint8Array.from(await storage.readBytes(result.clang)).buffer);
  return result;
};

self.addEventListener('message', async (event) => {
  try { self.postMessage({ value: await run(event.data) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
});
