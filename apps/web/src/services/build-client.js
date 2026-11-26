/** @typedef {{stage:string,message:string,percent?:number,transfer?:import('../../../../packages/registry/src/download.js').DownloadProgress}} BuildProgress */
/**
 * Main-thread RPC client for the Wicro Web Worker WASM build engine.
 * Keeps all compilation, linking, SHA-256 verification, and SDK extraction off the UI thread.
 */

export class WicroBuildClient {
  constructor() {
    this.worker = new Worker(new URL('../workers/build-worker.js', import.meta.url), { type: 'module' });
    this.nextId = 1;
    /** @type {((event:import('../../../../packages/registry/src/download.js').DownloadProgress & {requestId:string})=>void)|undefined} */
    this.onTransfer = undefined;
    /** @type {Map<string,import('../../../../packages/registry/src/download.js').DownloadProgress>} */
    this.transfers = new Map();
    /** @type {Map<string, {resolve:(value:any)=>void,reject:(error:Error)=>void,onProgress?:(event:BuildProgress)=>void}>} */
    this.pending = new Map();

    this.worker.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || !message.id) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      if (message.type === 'progress') {
        if (message.transfer) {
          this.transfers.set(message.id, message.transfer);
          this.onTransfer?.({ ...message.transfer, requestId: message.id });
        }
        entry.onProgress?.({ stage: message.stage, message: message.message, percent: message.percent, transfer: message.transfer });
        return;
      }
      if (message.type === 'result') {
        this.pending.delete(message.id);
        const transfer = this.transfers.get(message.id);
        if (transfer) this.onTransfer?.({ ...transfer, requestId: message.id, status: message.ok ? 'complete' : 'error' });
        this.transfers.delete(message.id);
        if (message.ok) entry.resolve(message.result);
        else entry.reject(new Error(message.error ?? 'Worker execution failed'));
      }
    });

    this.worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'Wicro build worker crashed');
      for (const entry of Array.from(this.pending.values())) entry.reject(error);
      this.pending.clear();
    });
  }

  /**
   * @param {string} type
   * @param {Record<string, unknown>} payload
   * @param {(event:BuildProgress)=>void} [onProgress]
   */
  request(type, payload = {}, onProgress) {
    const id = `req-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ id, type, payload });
    });
  }

  /**
   * @param {{boardId:string,framework?:string,projectFiles:Record<string,string>,offline?:boolean,clean?:boolean,formats?:string[]}} options
   * @param {(event:BuildProgress)=>void} [onProgress]
   */
  build(options, onProgress) {
    return this.request('build', { ...options, origin: new URL(import.meta.env.BASE_URL, window.location.href).href.replace(/\/$/, '') }, onProgress);
  }

  /**
   * @param {{boardId:string,projectFiles:Record<string,string>,activeFile:string}} options
   */
  diagnose(options) {
    return this.request('diagnose', { ...options, origin: new URL(import.meta.env.BASE_URL, window.location.href).href.replace(/\/$/, '') });
  }

  /**
   * @param {{boardId:string,projectFiles:Record<string,string>,activeFile:string,line:number,column:number}} options
   */
  complete(options) {
    return this.request('complete', { ...options, origin: new URL(import.meta.env.BASE_URL, window.location.href).href.replace(/\/$/, '') });
  }

  /** @param {string} type @param {Record<string,unknown>} payload */
  libraries(type, payload) {
    return this.request(type, { ...payload, origin: new URL(import.meta.env.BASE_URL, window.location.href).href.replace(/\/$/, '') });
  }

  /** @param {string} requestId @param {'pause'|'resume'|'cancel'} action */
  controlTransfer(requestId, action) { this.worker.postMessage({ type: 'transferControl', payload: { requestId, action } }); }

  discoverStm32Boards(options = {}) {
    return this.request('discoverStm32Boards', { ...options, origin: new URL(import.meta.env.BASE_URL, window.location.href).href.replace(/\/$/, '') });
  }

  cacheStatus() {
    return this.request('cacheStatus');
  }

  clearCache() {
    return this.request('clearCache');
  }

  dispose() {
    this.worker.terminate();
    this.pending.clear();
  }
}
