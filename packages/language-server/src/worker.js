export class WicroLanguageWorkerProtocol {
  /** @param {import('./index.js').WicroLanguageService} service */
  constructor(service) {
    this.service = service;
  }

  /** @param {{id:number|undefined,method:string,params?:Record<string,unknown>}} message */
  async handle(message) {
    const params = message.params ?? {};

    if (message.method === 'language/open') {
      const document = /** @type {{uri:string,languageId:string,text:string,version:number}} */ (params.document);
      this.service.openDocument(document);
      return { id: message.id, ok: true, value: await this.service.diagnostics(document.uri) };
    }

    if (message.method === 'language/change') {
      const uri = /** @type {string} */ (params.uri);
      const text = /** @type {string} */ (params.text);
      const version = /** @type {number} */ (params.version);
      const document = this.service.updateDocument(uri, text, version);
      return { id: message.id, ok: true, value: await this.service.diagnostics(document.uri) };
    }

    if (message.method === 'language/close') {
      const uri = /** @type {string} */ (params.uri);
      this.service.closeDocument(uri);
      return { id: message.id, ok: true, value: null };
    }

    if (message.method === 'language/completion') {
      const uri = /** @type {string} */ (params.uri);
      const position = /** @type {{line:number,character:number}} */ (params.position);
      return { id: message.id, ok: true, value: await this.service.completion(uri, position) };
    }

    if (message.method === 'language/hover') {
      const uri = /** @type {string} */ (params.uri);
      const position = /** @type {{line:number,character:number}} */ (params.position);
      return { id: message.id, ok: true, value: this.service.hover(uri, position) };
    }

    if (message.method === 'language/definition') {
      const uri = /** @type {string} */ (params.uri);
      const position = /** @type {{line:number,character:number}} */ (params.position);
      return { id: message.id, ok: true, value: this.service.definition(uri, position) };
    }

    if (message.method === 'language/references') {
      const uri = /** @type {string} */ (params.uri);
      const position = /** @type {{line:number,character:number}} */ (params.position);
      return { id: message.id, ok: true, value: this.service.references(uri, position) };
    }

    if (message.method === 'language/format') {
      const uri = /** @type {string} */ (params.uri);
      try {
        return { id: message.id, ok: true, value: await this.service.format(uri) };
      } catch (error) {
        return { id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    if (message.method === 'language/lint') {
      const uri = /** @type {string} */ (params.uri);
      try {
        return { id: message.id, ok: true, value: await this.service.lint(uri) };
      } catch (error) {
        return { id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    return { id: message.id, ok: false, error: `Unknown language worker method: ${message.method}` };
  }
}
