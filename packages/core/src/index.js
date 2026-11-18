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
 */

/**
 * Creates a host-independent Wicro engine.
 * @param {WicroEngineOptions} options
 */
export const createWicroEngine = (options) => {
  if (!options.host) throw new Error('A host adapter is required');

  return Object.freeze({
    host: options.host.host,

    /** @param {unknown} command @returns {Promise<WicroResult>} */
    async execute(command) {
      if (typeof command !== 'string' || command.trim().length === 0) {
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
  });
};
