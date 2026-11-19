import { LlvmWasmToolchain } from '../../runtime/src/index.js';

/** @typedef {'browser'|'node'|'vscode'} WicroHost */

/**
 * @typedef {object} WicroDiagnostic
 * @property {'error'|'warning'|'info'} severity
 * @property {string} message
 * @property {string} [source]
 * @property {string} [file]
 * @property {number} [line]
 * @property {number} [column]
 */

/**
 * @typedef {object} WicroResult
 * @property {boolean} ok
 * @property {unknown} [value]
 * @property {WicroDiagnostic[]} [diagnostics]
 */

/**
 * @typedef {object} WicroHostAdapter
 * @property {WicroHost} host
 * @property {(path: string, options?: {encoding?: 'utf8'|'binary'}) => Promise<string|Uint8Array>} readFile
 * @property {(path: string, data: string|Uint8Array) => Promise<void>} writeFile
 */

/**
 * @typedef {object} WicroEngineOptions
 * @property {WicroHostAdapter} host
 * @property {import('../../registry/src/index.js').PackageRegistry} [registry]
 * @property {LlvmWasmToolchain} [toolchain]
 * @property {string} [llvmPath]
 */

/**
 * Creates a host-independent Wicro engine.
 * @param {WicroEngineOptions} options
 */
export const createWicroEngine = (options) => {
  if (!options.host) throw new Error('A host adapter is required');

  const toolchain = options.toolchain ?? new LlvmWasmToolchain({
    llvmPath: options.llvmPath ?? 'toolchain/llvm-wasm/cache/llvm.wasm'
  });

  return Object.freeze({
    host: options.host.host,

    /**
     * Execute a host-independent command.
     * @param {string|{command:'build',project:string,board?:string}|{command:'compile',source:string,board:string}|{command:'targets'}} command
     * @returns {Promise<WicroResult>}
     */
    async execute(command) {
      if (typeof command === 'string') {
        if (command === 'targets') {
          try {
            const targets = await toolchain.targets();
            return { ok: true, value: targets };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, diagnostics: [{ severity: 'error', message }] };
          }
        }
        if (command.trim().length === 0) {
          return {
            ok: false,
            diagnostics: [{ severity: 'error', message: 'A command name is required' }]
          };
        }
        return {
          ok: false,
          diagnostics: [{ severity: 'info', message: `Command '${command}' is not implemented yet` }]
        };
      }

      if (command.command === 'targets') {
        return this.execute('targets');
      }

      if (command.command === 'compile') {
        const board = await loadBoardManifest(options.host, command.board);
        const build = asBuildManifest(board.metadata?.build);
        if (!build) {
          return { ok: false, diagnostics: [{ severity: 'error', message: `Board '${command.board}' has no compilation recipe` }] };
        }
        try {
          const result = await toolchain.compileC(command.source, build.target, build.targetOptions);
          return { ok: true, value: result, diagnostics: result.diagnostics.map((/** @type {string} */ message) => ({ severity: /** @type {'warning'} */ ('warning'), message })) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, diagnostics: [{ severity: 'error', message }] };
        }
      }

      if (command.command === 'build') {
        try {
          const result = await buildProject(options.host, toolchain, command.project, command.board);
          return { ok: true, value: result, diagnostics: result.diagnostics.map((/** @type {string} */ message) => ({ severity: /** @type {'warning'} */ ('warning'), message })) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, diagnostics: [{ severity: 'error', message }] };
        }
      }

      return { ok: false, diagnostics: [{ severity: 'error', message: 'Unsupported Wicro command' }] };
    }
  });
};

/**
 * @param {WicroHostAdapter} host
 * @param {string} boardName
 * @returns {Promise<import('../../registry/src/index.js').WicroPackageManifest>}
 */
const loadBoardManifest = async (host, boardName) => {
  const candidates = [
    `registry/${boardName}/package.json`,
    `../../../registry/${boardName}/package.json`,
    `../../registry/${boardName}/package.json`
  ];

  let lastError;
  for (const candidate of candidates) {
    try {
      const value = await host.readFile(candidate, { encoding: 'utf8' });
      if (typeof value === 'string') return /** @type {import('../../registry/src/index.js').WicroPackageManifest} */ (JSON.parse(value));
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Board package not found: ${boardName}`);
};

/**
 * @typedef {object} BuildManifest
 * @property {'object'|'bare-metal'} kind
 * @property {string} target
 * @property {{march?:string,mabi?:string,mcpu?:string,mcu?:string}} [targetOptions]
 * @property {string} [source]
 * @property {string} [startupSource]
 * @property {string} [linkerScript]
 * @property {string} [output]
 */

/** @param {unknown} value @returns {BuildManifest|undefined} */
const asBuildManifest = (value) => {
  if (!value || typeof value !== 'object') return undefined;
  const build = /** @type {Record<string, unknown>} */ (value);
  if (typeof build.target !== 'string') return undefined;
  if (build.kind !== 'object' && build.kind !== 'bare-metal') return undefined;

  const targetOptionsValue = build.targetOptions;
  const targetOptions = targetOptionsValue && typeof targetOptionsValue === 'object'
    ? /** @type {{march?:string,mabi?:string,mcpu?:string,mcu?:string}} */ (targetOptionsValue)
    : undefined;

  return /** @type {BuildManifest} */ ({
    kind: build.kind,
    target: build.target,
    targetOptions,
    source: typeof build.source === 'string' ? build.source : undefined,
    startupSource: typeof build.startupSource === 'string' ? build.startupSource : undefined,
    linkerScript: typeof build.linkerScript === 'string' ? build.linkerScript : undefined,
    output: typeof build.output === 'string' ? build.output : undefined
  });
};

/**
 * @param {WicroHostAdapter} host
 * @param {LlvmWasmToolchain} toolchain
 * @param {string} project
 * @param {string} [boardName]
 */
const buildProject = async (host, toolchain, project, boardName) => {
  let board = boardName;
  if (!board) {
    try {
      const manifestValue = await host.readFile(`${project}/wicro.json`, { encoding: 'utf8' });
      if (typeof manifestValue === 'string') {
        const manifest = /** @type {{board?:string}} */ (JSON.parse(manifestValue));
        board = manifest.board;
      }
    } catch {
      // Board must be supplied explicitly or resolved from the project manifest.
    }
  }
  if (!board) throw new Error('No board target was specified');

  const boardManifest = await loadBoardManifest(host, board);
  const build = asBuildManifest(boardManifest.metadata?.build);
  if (!build) throw new Error(`Board '${board}' has no compilation recipe`);

  const sourcePath = build.source ?? 'src/main.c';
  const sourceValue = await host.readFile(`${project}/${sourcePath}`, { encoding: 'utf8' });
  if (typeof sourceValue !== 'string') throw new Error(`Source file is not text: ${sourcePath}`);

  let result;
  if (build.kind === 'bare-metal') {
    if (!build.startupSource || !build.linkerScript) {
      throw new Error(`Board '${board}' has an incomplete bare-metal build recipe`);
    }
    const startupValue = await host.readFile(`${project}/${build.startupSource}`, { encoding: 'utf8' });
    const linkerValue = await host.readFile(`${project}/${build.linkerScript}`, { encoding: 'utf8' });
    if (typeof startupValue !== 'string' || typeof linkerValue !== 'string') {
      throw new Error(`Firmware sources for '${board}' must be text files`);
    }
    result = await toolchain.compileAndLinkBareMetal({
      source: sourceValue,
      startupSource: startupValue,
      linkerScript: linkerValue,
      target: build.target,
      targetOptions: build.targetOptions
    });
  } else {
    result = await toolchain.compileC(sourceValue, build.target, build.targetOptions);
  }

  const output = build.output ?? '.wicro/build';
  if ('elf' in result && 'bin' in result) {
    await host.writeFile(`${project}/${output}/firmware.elf`, result.elf);
    await host.writeFile(`${project}/${output}/firmware.bin`, result.bin);
  } else {
    await host.writeFile(`${project}/${output}/main.o`, result.object);
  }

  return {
    board,
    output,
    kind: build.kind,
    target: build.target,
    elf: 'elf' in result ? `${project}/${output}/firmware.elf` : undefined,
    bin: 'bin' in result ? `${project}/${output}/firmware.bin` : undefined,
    object: 'object' in result ? `${project}/${output}/main.o` : undefined,
    diagnostics: result.diagnostics
  };
};
