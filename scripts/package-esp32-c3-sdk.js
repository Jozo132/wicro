import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { zipSync } from 'fflate';
import { ESP32_C3_ARDUINO_RECIPE } from '../packages/core/src/platform/esp32.js';
import { sha256Bytes } from '../packages/registry/src/sdk.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const version = '4.20017.260907';
const sourceArg = process.argv.find((arg) => arg.startsWith('--source='))?.slice('--source='.length);
const outputArg = process.argv.find((arg) => arg.startsWith('--output='))?.slice('--output='.length);
const sourceRoot = resolve(sourceArg ?? join(root, 'registry-cache', `esp32-c3-sdk-${version}`));
const outputDir = resolve(outputArg ?? join(root, 'dist', 'assets'));

const allowedLibArchives = new Set(ESP32_C3_ARDUINO_RECIPE.libArchives);
const allowedLdFiles = new Set([
  'memory.ld',
  'sections.ld',
  ...ESP32_C3_ARDUINO_RECIPE.romLinkerScripts,
  ...ESP32_C3_ARDUINO_RECIPE.ldArchives
]);

/** @type {Record<string, Uint8Array>} */
const entries = {};

/**
 * Recursively collect files from a directory into the ZIP entries map.
 * @param {string} directory
 * @param {string} prefix
 * @param {(name: string) => boolean} [filter]
 */
const collectDirectory = async (directory, prefix, filter) => {
  const names = (await readdir(directory)).sort();
  for (const name of names) {
    const fullPath = join(directory, name);
    const info = await stat(fullPath);
    const entryPath = `${prefix}/${name}`;
    if (info.isDirectory()) {
      await collectDirectory(fullPath, entryPath, filter);
    } else if (!filter || filter(name)) {
      entries[entryPath] = new Uint8Array(await readFile(fullPath));
    }
  }
};

await collectDirectory(join(sourceRoot, 'core'), 'core');
await collectDirectory(join(sourceRoot, 'variant'), 'variant');
await collectDirectory(join(sourceRoot, 'include'), 'include');
await collectDirectory(join(sourceRoot, 'sysroot'), 'sysroot');
await collectDirectory(join(sourceRoot, 'ld'), 'ld', (name) => allowedLdFiles.has(name));
await collectDirectory(join(sourceRoot, 'lib'), 'lib', (name) => allowedLibArchives.has(name));

const zipBytes = zipSync(entries, { level: 6 });
const zipSha256 = await sha256Bytes(zipBytes);
const zipFilename = `esp32-c3-sdk-${version}.zip`;

await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, zipFilename), zipBytes);

const llvmPath = join(root, 'toolchain/llvm-wasm/cache/llvm.wasm');
let llvmSize = 0;
let llvmSha256 = null;
try {
  const llvmBytes = new Uint8Array(await readFile(llvmPath));
  llvmSize = llvmBytes.byteLength;
  llvmSha256 = await sha256Bytes(llvmBytes);
} catch {
  // Optional when packaging SDK without local compiler binary.
}

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  recipe: ESP32_C3_ARDUINO_RECIPE.version,
  assets: {
    'esp32-c3-sdk': {
      name: 'esp32-c3-sdk',
      version,
      filename: zipFilename,
      bytes: zipBytes.byteLength,
      fileCount: Object.keys(entries).length,
      sha256: zipSha256,
      components: {
        libArchives: ESP32_C3_ARDUINO_RECIPE.libArchives.length,
        ldArchives: ESP32_C3_ARDUINO_RECIPE.ldArchives.length,
        romLinkerScripts: ESP32_C3_ARDUINO_RECIPE.romLinkerScripts.length
      }
    },
    'llvm-wasm': {
      name: 'llvm-wasm',
      version: '202611141634-v6.0.3',
      filename: 'llvm.wasm',
      bytes: llvmSize,
      sha256: llvmSha256
    }
  }
};

await writeFile(join(outputDir, 'distribution-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
