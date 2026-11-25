import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createWicroEngine, applyFrameworkConfiguration } from './index.js';
import { NodeSdkStorage, defaultWicroCacheDirectory } from '../../registry/src/node-cache.js';
import { SdkLifecycleManager } from '../../registry/src/sdk.js';
import { CompilerAssetManager } from '../../registry/src/compiler-assets.js';
import { LlvmWasmToolchain } from '../../runtime/src/index.js';

/** Shared in-process Node/VS Code project build entry point. No subprocess or
 * platform-specific build command is used.
 * @param {{project:string,board?:string,framework?:string,registryRoot?:string,cacheDirectory?:string,offline?:boolean,toolchain?:LlvmWasmToolchain,llvmPath?:string,onProgress?:(event:{stage:string,message:string,percent?:number})=>void}} options
 */
export const buildNodeProject = async (options) => {
  const project = resolve(options.project), registryRoot = resolve(options.registryRoot ?? fileURLToPath(new URL('../../../registry', import.meta.url)));
  const config = JSON.parse(await readFile(join(project, 'wicro.json'), 'utf8'));
  if (options.framework) config.framework = options.framework;
  const board = options.board ?? config.board;
  if (!board) throw new Error('A board is required');
  const readManifest = async (/** @type {string} */ name) => JSON.parse(await readFile(join(registryRoot, name, 'package.json'), 'utf8'));
  const manifest = applyFrameworkConfiguration(await readManifest(board), config.framework);
  const storage = new NodeSdkStorage({ root: defaultWicroCacheDirectory(options.cacheDirectory) });
  const lifecycle = new SdkLifecycleManager({ storage });
  let sdkCacheDirectory;
  for (const dependency of Object.keys(manifest.dependencies ?? {}).filter((name) => name.endsWith('-sdk'))) {
    const sdk = await readManifest(dependency);
    /** @type {Record<string,string>} */ const localSources = {};
    for (const base of [resolve('dist/assets'), resolve(registryRoot, '../dist/assets')]) {
      const path = join(base, `${dependency}-${sdk.version}.zip`);
      try { await readFile(path); localSources[dependency] = pathToFileURL(path).href; break; }
      catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error; }
    }
    const installed = await lifecycle.ensure(sdk, { localSources, offline: options.offline });
    sdkCacheDirectory = storage.absolute(installed.target);
  }
  let toolchain = options.toolchain;
  if (!toolchain) {
    let llvmPath = options.llvmPath;
    if (!llvmPath) {
      const compiler = structuredClone(await readManifest('llvm-wasm')); delete compiler.artifacts.ld;
      /** @type {Record<string,string>} */ const localSources = {};
      const path = resolve(registryRoot, '../toolchain/llvm-wasm/cache/llvm.wasm');
      try { await readFile(path); localSources.clang = pathToFileURL(path).href; }
      catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error; }
      const installed = await new CompilerAssetManager({ storage }).ensure(compiler, { localSources, offline: options.offline });
      llvmPath = storage.absolute(installed.clang);
    }
    toolchain = new LlvmWasmToolchain({ llvmPath });
  }
  /** @param {string} path */
  const mapped = (path) => {
    const match = path.replace(/\\/g, '/').match(/(?:^|\/)registry\/([^/]+)(?:\/(.*))?$/);
    return match ? resolve(registryRoot, match[1], match[2] ?? 'package.json') : resolve(path);
  };
  const engine = createWicroEngine({ toolchain, onProgress: options.onProgress, host: {
    host: 'node', libraryStorage: storage, cacheDirectory: storage.root, sdkCacheDirectory, offline: options.offline,
    readFile: async (path, settings) => path === join(project, 'wicro.json') && settings?.encoding === 'utf8' ? JSON.stringify(config) : settings?.encoding === 'utf8' ? readFile(mapped(path), 'utf8') : readFile(mapped(path)),
    readdir: async (path) => readdir(mapped(path)),
    writeFile: async (path, bytes) => { await mkdir(dirname(resolve(path)), { recursive: true }); await writeFile(resolve(path), bytes); }
  } });
  return engine.execute({ command: 'build', project, board });
};
