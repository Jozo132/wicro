import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { composeSdkArchive } from '../packages/registry/src/sdk-composition.js';
import { NodeSdkStorage } from '../packages/registry/src/node-cache.js';
import { sha256Bytes } from '../packages/registry/src/sdk.js';

const names = process.argv.slice(2).filter((name) => !name.startsWith('--'));
if (!names.length) throw new Error('Usage: node scripts/compose-sdk.js <sdk-name> [--record]');
const storage = new NodeSdkStorage({ root: '.wicro/arduino-all/composition-cache' });
for (const name of names) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid SDK manifest name');
  const path = `registry/${name}/package.json`, manifest = JSON.parse(await readFile(path, 'utf8'));
  for (const source of manifest.metadata.composition.sources) {
    const local = `.wicro/arduino-all/upstream/${new URL(source.url).pathname.split('/').at(-1)}`;
    try {
      const bytes = new Uint8Array(await readFile(local));
      if (await sha256Bytes(bytes) === source.sha256) { await storage.mkdir('upstreams'); await storage.writeBytes(`upstreams/${source.sha256}.artifact`, bytes); }
    } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error; }
  }
  const archive = await composeSdkArchive(manifest.metadata.composition, { storage });
  const sha256 = await sha256Bytes(archive);
  if (process.argv.includes('--record')) {
    manifest.metadata.distribution = { url: '', mirrors: [], archiveType: 'zip', sha256, bytes: archive.length };
    await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
  } else if (sha256 !== manifest.metadata.distribution.sha256) throw new Error(`Derived SDK identity mismatch for ${name}`);
  await mkdir('dist/assets', { recursive: true });
  await writeFile(`dist/assets/${name}-${manifest.version}.zip`, archive);
  console.log(JSON.stringify({ name, bytes: archive.length, sha256 }));
}
