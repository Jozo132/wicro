import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const llvmPath = resolve('../../toolchain/llvm-wasm/cache/llvm.wasm');

export default defineConfig({
  publicDir: 'public',
  plugins: [
    {
      name: 'wicro-common-llvm-wasm',
      configureServer(server) {
        server.middlewares.use('/toolchain/llvm.wasm', async (_request, response, next) => {
          try {
            const wasm = await readFile(llvmPath);
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/wasm');
            response.setHeader('Cache-Control', 'public, max-age=3600');
            response.end(wasm);
          } catch (error) {
            next(error);
          }
        });
      },
      async generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'toolchain/llvm.wasm',
          source: await readFile(llvmPath)
        });
      }
    }
  ]
});
