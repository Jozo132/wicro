import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const packageRoot = resolve(root, 'packages/wicro');

const copyTargets = [
  ['packages/core/src', 'packages/wicro/vendor/core/src'],
  ['packages/runtime/src', 'packages/wicro/vendor/runtime/src'],
  ['packages/registry/src', 'packages/wicro/vendor/registry/src'],
  ['packages/filesystem/src', 'packages/wicro/vendor/filesystem/src'],
  ['packages/hardware/src', 'packages/wicro/vendor/hardware/src'],
  ['packages/programmers/src', 'packages/wicro/vendor/programmers/src'],
  ['packages/arduino/src', 'packages/wicro/vendor/arduino/src'],
  ['registry', 'packages/wicro/registry'],
  ['toolchain/llvm-wasm/manifest.json', 'packages/wicro/toolchain/llvm-wasm/manifest.json']
];

await rm(resolve(packageRoot, 'vendor'), { recursive: true, force: true });
await rm(resolve(packageRoot, 'registry'), { recursive: true, force: true });
await rm(resolve(packageRoot, 'toolchain'), { recursive: true, force: true });

for (const [source, target] of copyTargets) {
  const sourcePath = resolve(root, source);
  const targetPath = resolve(root, target);
  await mkdir(resolve(targetPath, '..'), { recursive: true });
  await cp(sourcePath, targetPath, { recursive: true, dereference: true });
}

const coreIndex = resolve(packageRoot, 'vendor/core/src/index.js');
const { readFile, writeFile } = await import('node:fs/promises');
let core = await readFile(coreIndex, 'utf8');
core = core.replace("../../runtime/src/index.js", "../../runtime/src/index.js");
core = core.replace("../../registry/src/index.js", "../../registry/src/index.js");
await writeFile(coreIndex, core);
