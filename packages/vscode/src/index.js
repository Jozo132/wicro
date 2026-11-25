import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LlvmWasmToolchain } from '../../runtime/src/index.js';
import { NodeSerialHost } from '../../hardware/src/index.js';
import { WicroLanguageService } from '../../language-server/src/index.js';
import { buildNodeProject } from '../../core/src/node-build.js';

export class VSCodeHostAdapter {
  /** @param {{workspaceRoot?:string,llvmPath?:string,toolchain?:LlvmWasmToolchain,resolveToolchain?:()=>Promise<{llvmPath:string,linkerPath?:string}>}} [options] */
  constructor(options = {}) {
    this.workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
    this.resolveToolchain = options.resolveToolchain;
    this.toolchain = options.toolchain ?? (options.llvmPath
      ? new LlvmWasmToolchain({ llvmPath: options.llvmPath })
      : undefined);
    this.languageService = new WicroLanguageService({
      host: 'vscode',
      toolchain: this.toolchain ?? /** @type {any} */ ({})
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

  async ensureToolchain() {
    if (this.toolchain) return this.toolchain;
    if (!this.resolveToolchain) throw new Error('LLVM WASM toolchain asset is not installed');
    const resolved = await this.resolveToolchain();
    this.toolchain = new LlvmWasmToolchain({ llvmPath: resolved.llvmPath, linkerPath: resolved.linkerPath });
    this.languageService = new WicroLanguageService({ host: 'vscode', toolchain: this.toolchain });
    return this.toolchain;
  }

  /** @param {string} source @param {string} target @param {{march?:string,mabi?:string,mcpu?:string,mcu?:string}} [targetOptions] */
  async compileSource(source, target = 'riscv32', targetOptions) {
    const toolchain = await this.ensureToolchain();
    return toolchain.compileC(source, target, targetOptions);
  }

  /** @param {{source:string,startupSource:string,linkerScript:string,target:string,targetOptions?:{mcpu?:string,mcu?:string,march?:string,mabi?:string}}} options */
  async compileBareMetal(options) {
    const toolchain = await this.ensureToolchain();
    return toolchain.compileAndLinkBareMetal(options);
  }

  /** Build a complete project with the same engine, SDK acquisition and WASM
   * compiler as the Node CLI. @param {{project?:string,board?:string,framework?:string,offline?:boolean,cacheDirectory?:string}} [options]
   */
  buildProject(options = {}) {
    return buildNodeProject({ ...options, project: resolve(this.workspaceRoot, options.project ?? '.'), toolchain: this.toolchain });
  }

  /** @param {{uri:string,languageId:string,text:string,version:number}} document */
  openDocument(document) {
    if (!this.languageService) throw new Error('LLVM WASM language tooling is not installed');
    this.languageService.openDocument(document);
  }

  /** @param {string} uri @param {string} text @param {number} [version] */
  updateDocument(uri, text, version) {
    return this.languageService.updateDocument(uri, text, version);
  }

  /** @param {string} uri */
  async documentDiagnostics(uri) {
    return this.languageService.diagnostics(uri);
  }

  /** @param {string} uri @param {{line:number,character:number}} position */
  async documentCompletion(uri, position) {
    return this.languageService.completion(uri, position);
  }

  /** @param {string} uri @param {{line:number,character:number}} position */
  documentHover(uri, position) {
    return this.languageService.hover(uri, position);
  }

  /** @param {string} uri @param {{line:number,character:number}} position */
  documentDefinition(uri, position) {
    return this.languageService.definition(uri, position);
  }

  /** @param {string} uri @param {{line:number,character:number}} position */
  documentReferences(uri, position) {
    return this.languageService.references(uri, position);
  }

  /** @param {string} uri @param {{line:number,character:number}} position @param {string} newName */
  async renameDocumentSymbol(uri, position, newName) {
    return this.languageService.rename(uri, position, newName);
  }

  /** @param {string[]} files @param {{directory?:string,target?:string,targetOptions?:{march?:string,mabi?:string,mcpu?:string,mcu?:string},includeDirs?:string[],defines?:string[]}} [options] */
  compileCommands(files, options = {}) {
    if (options.target || options.targetOptions || options.includeDirs || options.defines) {
      this.languageService.configuration = {
        target: options.target ?? 'riscv32',
        targetOptions: options.targetOptions,
        includeDirs: options.includeDirs,
        defines: options.defines
      };
    }
    return this.languageService.createCompileCommands({
      root: this.workspaceRoot,
      files,
      directory: options.directory ?? this.workspaceRoot
    });
  }

  async devices() {
    return new NodeSerialHost().discover();
  }

  commands() {
    return [
      'wicro.boardList',
      'wicro.compileSource',
      'wicro.compileBareMetal',
      'wicro.buildProject',
      'wicro.deviceList',
      'wicro.documentDiagnostics',
      'wicro.documentCompletion',
      'wicro.documentHover',
      'wicro.documentDefinition',
      'wicro.documentReferences',
      'wicro.renameDocumentSymbol',
      'wicro.compileCommands'
    ];
  }
}
