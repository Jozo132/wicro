import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { defineConfig } from 'vite';

const repoRoot = resolve('../..');
const llvmPath = resolve(repoRoot, 'toolchain/llvm-wasm/cache/llvm.wasm');
const ldPath = resolve(repoRoot, 'toolchain/llvm-wasm/cache/ld.wasm');
const registryDir = resolve(repoRoot, 'registry');
const examplesDir = resolve(repoRoot, 'examples');
const distAssetsDir = resolve(repoRoot, 'dist/assets');

const EXAMPLE_SOURCE_RE = /\.(ino|pde|c|cc|cpp|cxx|h|hpp|s|S|asm|ld|lds|json)$/i;
const IGNORED_DIRS = new Set(['build', '.wicro', 'node_modules']);

/** Read all canonical registry manifests from `registry/<name>/package.json`. */
const loadCanonicalRegistry = async () => {
  const entries = await readdir(registryDir, { withFileTypes: true });
  /** @type {Record<string, any>} */
  const packages = {};
  /** @type {any[]} */
  const boards = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await readFile(join(registryDir, entry.name, 'package.json'), 'utf8');
      const manifest = JSON.parse(raw);
      packages[entry.name] = manifest;
      if (manifest.kind === 'board') {
        boards.push({
          id: entry.name,
          name: manifest.name,
          description: manifest.description,
          dependencies: manifest.dependencies ?? {},
          metadata: manifest.metadata ?? {}
        });
      }
    } catch {
      // Skip non-package directories.
    }
  }

  boards.sort((left, right) => {
    if (left.id === 'esp32-c3-supermini') return -1;
    if (right.id === 'esp32-c3-supermini') return 1;
    return left.id.localeCompare(right.id);
  });

  return { packages, boards };
};

/** Recursively collect text source files for a single example directory. */
const readExampleFiles = async (/** @type {string} */ rootDir, /** @type {string} */ prefix = '') => {
  /** @type {Record<string, string>} */
  const files = {};
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = join(rootDir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(files, await readExampleFiles(full, rel));
    } else if (EXAMPLE_SOURCE_RE.test(entry.name)) {
      files[rel] = await readFile(full, 'utf8');
    }
  }
  return files;
};

/** Scan `examples/<board>/<example>` and return structured example descriptors. */
const loadCanonicalExamples = async () => {
  /** @type {Array<{id:string,board:string,name:string,framework:string,files:Record<string,string>}>} */
  const examples = [];
  const boardDirs = await readdir(examplesDir, { withFileTypes: true });
  for (const boardDir of boardDirs) {
    if (!boardDir.isDirectory()) continue;
    const boardPath = join(examplesDir, boardDir.name);
    const exampleDirs = await readdir(boardPath, { withFileTypes: true });
    for (const exampleDir of exampleDirs) {
      if (!exampleDir.isDirectory() || IGNORED_DIRS.has(exampleDir.name)) continue;
      const examplePath = join(boardPath, exampleDir.name);
      const files = await readExampleFiles(examplePath);
      if (Object.keys(files).length === 0) continue;
      let board = boardDir.name;
      let framework = 'arduino';
      if (files['wicro.json']) {
        try {
          const parsed = JSON.parse(files['wicro.json']);
          if (typeof parsed.board === 'string') board = parsed.board;
          if (typeof parsed.framework === 'string') framework = parsed.framework;
        } catch {
          // Use directory defaults.
        }
      } else if (exampleDir.name.includes('bare-metal')) {
        framework = 'bare-metal';
      }
      examples.push({
        id: `${boardDir.name}/${exampleDir.name}`,
        board,
        name: exampleDir.name,
        framework,
        files
      });
    }
  }

  examples.sort((left, right) => {
    if (left.id === 'esp32-c3-supermini/blink') return -1;
    if (right.id === 'esp32-c3-supermini/blink') return 1;
    return left.id.localeCompare(right.id);
  });

  return examples;
};

export default defineConfig({
  publicDir: 'public',
  worker: {
    format: 'es'
  },
  server: {
    fs: {
      allow: [repoRoot]
    }
  },
  plugins: [
    {
      name: 'wicro-canonical-platform-assets',
      configureServer(server) {
        server.middlewares.use('/toolchain/llvm.wasm', async (_request, response, next) => {
          try {
            const wasm = await readFile(llvmPath);
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/wasm');
            response.setHeader('Content-Length', String(wasm.byteLength));
            response.setHeader('Cache-Control', 'public, max-age=3600');
            response.end(wasm);
          } catch (error) {
            next(error);
          }
        });

        server.middlewares.use('/toolchain/ld.wasm', async (_request, response, next) => {
          try {
            const wasm = await readFile(ldPath);
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/wasm');
            response.setHeader('Content-Length', String(wasm.byteLength));
            response.setHeader('Cache-Control', 'public, max-age=3600');
            response.end(wasm);
          } catch {
            next();
          }
        });

        server.middlewares.use('/registry', async (request, response, next) => {
          try {
            const urlPath = (request.url ?? '/').split('?')[0];
            if (urlPath === '/boards.json' || urlPath === '/boards') {
              const { boards } = await loadCanonicalRegistry();
              response.statusCode = 200;
              response.setHeader('Content-Type', 'application/json; charset=utf-8');
              response.setHeader('Cache-Control', 'no-cache');
              response.end(JSON.stringify(boards));
              return;
            }
            const pkgMatch = urlPath.match(/^\/([a-z0-9._-]+)\/package\.json$/i);
            if (pkgMatch) {
              const raw = await readFile(join(registryDir, pkgMatch[1], 'package.json'), 'utf8');
              response.statusCode = 200;
              response.setHeader('Content-Type', 'application/json; charset=utf-8');
              response.setHeader('Cache-Control', 'no-cache');
              response.end(raw);
              return;
            }
            next();
          } catch {
            next();
          }
        });

        server.middlewares.use('/examples', async (request, response, next) => {
          try {
            const urlPath = (request.url ?? '/').split('?')[0];
            if (urlPath === '/index.json' || urlPath === '/') {
              const examples = await loadCanonicalExamples();
              response.statusCode = 200;
              response.setHeader('Content-Type', 'application/json; charset=utf-8');
              response.setHeader('Cache-Control', 'no-cache');
              response.end(JSON.stringify(examples));
              return;
            }
            next();
          } catch (error) {
            next(error);
          }
        });

        server.middlewares.use('/assets', async (request, response, next) => {
          try {
            const urlPath = (request.url ?? '/').split('?')[0].replace(/^\/+/, '');
            if (!urlPath || urlPath.includes('..') || urlPath.includes('/')) {
              next();
              return;
            }
            const assetPath = join(distAssetsDir, urlPath);
            const info = await stat(assetPath);
            if (!info.isFile()) {
              next();
              return;
            }
            const data = await readFile(assetPath);
            response.statusCode = 200;
            response.setHeader('Content-Type', urlPath.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/zip');
            response.setHeader('Content-Length', String(data.byteLength));
            response.setHeader('Cache-Control', 'public, max-age=3600');
            response.end(data);
          } catch {
            next();
          }
        });
      },
      async generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'toolchain/llvm.wasm',
          source: await readFile(llvmPath)
        });
        const { packages, boards } = await loadCanonicalRegistry();
        this.emitFile({
          type: 'asset',
          fileName: 'registry/boards.json',
          source: JSON.stringify(boards, null, 2)
        });
        for (const [name, manifest] of Object.entries(packages)) {
          this.emitFile({
            type: 'asset',
            fileName: `registry/${name}/package.json`,
            source: JSON.stringify(manifest, null, 2)
          });
        }
        const examples = await loadCanonicalExamples();
        this.emitFile({
          type: 'asset',
          fileName: 'examples/index.json',
          source: JSON.stringify(examples, null, 2)
        });
      }
    }
  ]
});
