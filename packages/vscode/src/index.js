import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LlvmWasmToolchain } from '../../runtime/src/index.js';
import { NodeSerialHost } from '../../hardware/src/index.js';

export class VSCodeHostAdapter {
  /** @param {{workspaceRoot?:string,llvmPath?:string}} [options] */
  constructor(options = {}) {
    this.workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
    this.toolchain = new LlvmWasmToolchain({
      llvmPath: options.llvmPath ?? resolve(this.workspaceRoot, 'toolchain/llvm-wasm/cache/llvm.wasm')
    });
  }

  async boardList() {
    let registryRoot = resolve(this.workspaceRoot, 'registry');
    try {
      await readdir(registryRoot);
    } catch {
      registryRoot = resolve(new URL('../../../registry', import.meta.url).pathname);
    }
    const names = await readdir(registryRoot);
    const boards = [];

    for (const name of names) {
      try {
        const manifest = JSON.parse(await readFile(resolve(registryRoot, name, 'package.json'), 'utf8'));
        if (manifest.kind === 'board') {
          boards.push({
            name: manifest.name,
            mcu: manifest.metadata?.mcu,
            architecture: manifest.metadata?.architecture
          });
        }
      } catch {
        // Ignore incomplete registry entries.
      }
    }

    boards.sort((left, right) => left.name.localeCompare(right.name));
    return boards;
  }

  /** @param {string} source @param {string} target @param {{march?:string,mabi?:string,mcpu?:string,mcu?:string}} [targetOptions] */
  async compileSource(source, target = 'riscv32', targetOptions) {
    return this.toolchain.compileC(source, target, targetOptions);
  }

  /** @param {{source:string,startupSource:string,linkerScript:string,target:string,targetOptions?:{mcpu?:string,mcu?:string,march?:string,mabi?:string}}} options */
  async compileBareMetal(options) {
    return this.toolchain.compileAndLinkBareMetal(options);
  }

  async devices() {
    return new NodeSerialHost().discover();
  }

  commands() {
    return [
      'wicro.boardList',
      'wicro.compileSource',
      'wicro.compileBareMetal',
      'wicro.deviceList'
    ];
  }
}
