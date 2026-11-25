import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { composeSdkArchive } from '../packages/registry/src/sdk-composition.js';
import { NodeSdkStorage } from '../packages/registry/src/node-cache.js';
import { sha256Bytes } from '../packages/registry/src/sdk.js';

// Optional development precomposition. Production Node/browser acquisition uses
// the same committed recipe and upstream SHA-256 identities on demand.
const storage = new NodeSdkStorage({ root: '.wicro/stm32-sdk/composition-cache' });
for (const family of ['f1', 'f4']) {
  const name = `stm32-${family}-arduino-sdk`;
  const manifest = JSON.parse(await readFile(`registry/${name}/package.json`, 'utf8'));
  for (const source of manifest.metadata.composition.sources) {
    // Reuse a previously acquired development archive only after hashing it.
    const local = source.format === 'github-blob'
      ? `.wicro/stm32-sdk/${source.output.includes('arm_acle') ? 'arm_acle.h' : 'LLVM-LICENSE.TXT'}`
      : `.wicro/stm32-sdk/upstream/${new URL(source.url).pathname.split('/').at(-1)}`;
    try {
      const bytes = new Uint8Array(await readFile(local));
      if (await sha256Bytes(bytes) === source.sha256) { await storage.mkdir('upstreams'); await storage.writeBytes(`upstreams/${source.sha256}.artifact`, bytes); }
    } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error; }
  }
  const archive = await composeSdkArchive(manifest.metadata.composition, { storage });
  const sha256 = await sha256Bytes(archive);
  if (sha256 !== manifest.metadata.distribution.sha256) throw new Error(`Composed ${name} does not match the committed SDK identity`);
  await mkdir('dist/assets', { recursive: true });
  await writeFile(`dist/assets/${name}-${manifest.version}.zip`, archive);
  console.log(JSON.stringify({ name, bytes: archive.length, sha256 }));
}
