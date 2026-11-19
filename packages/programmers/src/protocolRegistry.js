/**
 * @typedef {object} ProgrammerProtocolContext
 * @property {unknown} transport
 * @property {Record<string, unknown>} [options]
 */

/**
 * @typedef {object} ProgrammerProtocol
 * @property {(context: ProgrammerProtocolContext) => Promise<unknown>|unknown} probe
 * @property {(context: ProgrammerProtocolContext, files: {address:number,data:Uint8Array}[], options?:Record<string,unknown>) => Promise<unknown>|unknown} writeFlash
 * @property {(context: ProgrammerProtocolContext) => Promise<void>|void} [disconnect]
 */

/** @typedef {(context: ProgrammerProtocolContext) => ProgrammerProtocol|Promise<ProgrammerProtocol>} ProgrammerProtocolFactory */

export class ProgrammerProtocolRegistry {
  constructor() {
    /** @type {Map<string, ProgrammerProtocolFactory>} */
    this.factories = new Map();
  }

  /** @param {string} name @param {ProgrammerProtocolFactory} factory */
  register(name, factory) {
    if (!name.trim()) throw new Error('A programmer protocol name is required');
    if (typeof factory !== 'function') throw new Error(`Invalid programmer protocol factory: ${name}`);
    this.factories.set(name.toLowerCase(), factory);
    return this;
  }

  /** @param {string} name @param {ProgrammerProtocolContext} context */
  async create(name, context) {
    const factory = this.factories.get(name.toLowerCase());
    if (!factory) throw new Error(`Unknown programmer protocol: ${name}`);
    return factory(context);
  }

  /** @returns {string[]} */
  names() {
    return [...this.factories.keys()].sort();
  }
}

export const programmerProtocols = new ProgrammerProtocolRegistry();

programmerProtocols.register('simulated', async () => ({
  /** @param {ProgrammerProtocolContext} context */
  async probe(context) {
    return { ok: true, protocol: 'simulated', transport: context.transport !== undefined };
  },
  /** @param {ProgrammerProtocolContext} context @param {{address:number,data:Uint8Array}[]} files */
  async writeFlash(context, files) {
    let bytes = 0;
    for (const file of files) {
      if (!Number.isInteger(file.address) || file.address < 0) throw new Error(`Invalid flash address: ${file.address}`);
      if (!(file.data instanceof Uint8Array) || file.data.length === 0) throw new Error('Flash image data is required');
      bytes += file.data.length;
    }
    return { ok: true, protocol: 'simulated', bytes, files: files.length };
  },
  async disconnect() {}
}));
