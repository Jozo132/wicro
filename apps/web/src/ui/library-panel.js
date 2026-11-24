/** @param {unknown} value */
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);

export class LibraryPanel {
  /** @param {HTMLElement} root @param {import('../state/ide-store.js').IdeStore} store @param {import('../services/build-client.js').WicroBuildClient} client @param {()=>void} syncEditor */
  constructor(root, store, client, syncEditor) {
    this.root = root;
    this.store = store;
    this.client = client;
    this.syncEditor = syncEditor;
    this.busy = false;
    root.innerHTML = `
      <div class="config-heading"><div><span class="config-eyebrow">DEPENDENCIES</span><h2>Libraries & packages</h2></div><button id="library-close" class="btn-tiny" type="button" aria-label="Close library browser">×</button></div>
      <p class="config-help">Browse source libraries, install their dependencies, and use them in your sketch.</p>
      <form id="library-search-form" class="library-search">
        <label class="config-field">Registry<select id="library-provider"><option value="arduino">Arduino Library Manager</option><option value="platformio">PlatformIO Libraries</option><option value="archive">Archive URL</option></select></label>
        <div id="library-registry-fields"><label class="config-field">Search<input id="library-query" type="search" placeholder="SSD1306, ArduinoJson, PubSubClient…" required></label><div class="library-actions"><button class="btn btn-primary" type="submit">Search</button><label class="config-check"><input id="library-refresh" type="checkbox"> Refresh catalog</label></div></div>
        <div id="library-archive-fields" hidden>
          <label class="config-field">Library name<input id="library-archive-name"></label>
          <label class="config-field">Version<input id="library-archive-version" placeholder="1.0.0"></label>
          <label class="config-field">Source archive URL<input id="library-archive-url" type="url" placeholder="https://…/library.zip"></label>
          <label class="config-field">SHA-256<input id="library-archive-sha" spellcheck="false"></label>
          <button id="library-archive-install" class="btn btn-primary" type="button">Import archive</button>
        </div>
      </form>
      <p id="library-status" class="config-help" role="status" aria-live="polite">Choose a registry and search to load its catalog.</p>
      <div id="library-results" class="library-results"></div>
      <div class="section-header library-installed-heading">PROJECT LIBRARIES</div>
      <div id="library-installed"></div>
      <div id="library-preview" hidden><label class="config-field">Package files<select id="library-file"></select></label><pre id="library-file-content" tabindex="0"></pre></div>
      <p class="config-help library-hook-note">Libraries with required Python/SCons hooks need an explicit Wicro build recipe. Toolchain and platform packages cannot be imported as source libraries.</p>`;
    this.status = /** @type {HTMLElement} */ (root.querySelector('#library-status'));
    root.querySelector('#library-close')?.addEventListener('click', () => { root.hidden = true; document.querySelector('#wicro-libraries')?.setAttribute('aria-expanded', 'false'); });
    root.querySelector('#library-provider')?.addEventListener('change', () => {
      const archive = this.input('library-provider').value === 'archive';
      /** @type {HTMLElement} */ (root.querySelector('#library-archive-fields')).hidden = !archive;
      /** @type {HTMLElement} */ (root.querySelector('#library-registry-fields')).hidden = archive;
      this.input('library-query').required = !archive;
    });
    root.querySelector('#library-search-form')?.addEventListener('submit', (event) => { event.preventDefault(); void this.search(); });
    root.querySelector('#library-archive-install')?.addEventListener('click', () => {
      const url = this.input('library-archive-url').value;
      try { new URL(url); } catch { this.status.textContent = 'Enter a valid source archive URL.'; return; }
      void this.install({ provider: 'archive', name: this.input('library-archive-name').value, version: this.input('library-archive-version').value, url, sha256: this.input('library-archive-sha').value, archiveType: new URL(url).pathname.endsWith('.gz') ? 'tar.gz' : 'zip' });
    });
    store.subscribe((changed) => { if (['project', 'configuration', 'file-content', 'build', 'flash'].includes(changed)) this.renderInstalled(); });
    this.renderInstalled();
  }

  /** @param {string} id */
  input(id) { return /** @type {HTMLInputElement} */ (this.root.querySelector(`#${id}`)); }

  async search() {
    this.status.textContent = 'Loading library catalog…';
    try {
      const releases = await this.client.libraries('librarySearch', { provider: this.input('library-provider').value, query: this.input('library-query').value, refresh: this.input('library-refresh').checked, offline: this.store.offline });
      const results = /** @type {HTMLElement} */ (this.root.querySelector('#library-results'));
      results.replaceChildren();
      for (const release of releases) {
        const article = document.createElement('article');
        article.className = 'library-card';
        article.innerHTML = `<strong>${escape(release.owner ? `${release.owner}/${release.name}` : release.name)}</strong><p>${escape(release.description)}</p><div class="library-actions"><label class="config-field">Version<input aria-label="Version for ${escape(release.name)}" value="${escape(release.version)}"></label><button type="button" class="btn btn-secondary library-install">Add</button></div><small>${escape(release.license || 'License details are retained in the package')}</small>`;
        article.querySelector('button')?.addEventListener('click', () => { void this.install({ provider: release.provider, name: release.name, owner: release.owner, version: /** @type {HTMLInputElement} */ (article.querySelector('input')).value }); });
        results.appendChild(article);
      }
      this.renderInstalled();
      this.status.textContent = `${releases.length} results. Versions are pinned when added; dependencies are resolved automatically.`;
    } catch (error) { this.status.textContent = error instanceof Error ? error.message : String(error); }
  }

  /** @param {import('../../../../packages/registry/src/library-catalog.js').LibraryRequest} request */
  async install(request) {
    if (this.busy || this.store.buildStatus === 'building' || this.store.flashStatus === 'flashing') return;
    if (this.store.configurationIssues.length) { this.status.textContent = 'Correct the project configuration before importing libraries.'; return; }
    this.busy = true;
    this.renderInstalled();
    const before = this.store.files.get('wicro.json');
    this.status.textContent = `Installing ${request.name} and resolving dependencies…`;
    try {
      const result = await this.client.libraries('libraryInstall', { request, boardId: this.store.boardId, projectFiles: this.store.snapshotFiles(), offline: this.store.offline });
      if (before !== this.store.files.get('wicro.json')) throw new Error('Project configuration changed during installation; retry with the current settings.');
      this.store.updateConfiguration({ libraries: result.requests });
      this.store.setFileContent('wicro-libraries.lock.json', JSON.stringify(result.lock, null, 2));
      this.syncEditor();
      this.store.emit('project');
      this.status.textContent = `Installed ${result.libraries.map((/** @type {any} */ entry) => `${entry.name} ${entry.version}`).join(', ')}. Sources cached; build to validate target compatibility.`;
    } catch (error) { this.status.textContent = error instanceof Error ? error.message : String(error); }
    finally { this.busy = false; this.renderInstalled(); }
  }

  renderInstalled() {
    const busy = this.busy || this.store.buildStatus === 'building' || this.store.flashStatus === 'flashing';
    for (const button of this.root.querySelectorAll('.library-install, #library-archive-install')) /** @type {HTMLButtonElement} */ (button).disabled = busy;
    const container = /** @type {HTMLElement} */ (this.root.querySelector('#library-installed'));
    container.replaceChildren();
    const requests = Array.isArray(this.store.configuration.libraries) ? this.store.configuration.libraries : [];
    let releases = [];
    try { releases = JSON.parse(this.store.files.get('wicro-libraries.lock.json') ?? '{}').libraries ?? []; } catch { /* The JSON editor retains an incomplete lock. */ }
    if (!requests.length) { container.innerHTML = '<p class="config-help">No third-party libraries declared. Add one above or edit libraries in wicro.json.</p>'; return; }
    const entries = releases.length ? releases : requests;
    for (const release of entries) {
      const article = document.createElement('article');
      article.className = 'library-card';
      const declaration = requests.find((/** @type {any} */ entry) => entry.provider === release.provider && entry.name === release.name && entry.owner === release.owner);
      article.innerHTML = `<strong>${escape(release.name)} <small>${escape(release.version ?? '*')}</small></strong><span class="config-help">${declaration ? 'Project dependency' : 'Resolved dependency / framework source'}</span><div class="library-actions">${release.sha256 ? '<button type="button" class="btn-tiny library-browse">Browse files</button>' : ''}${declaration ? '<button type="button" class="btn-tiny library-remove">Remove</button>' : ''}</div>`;
      article.querySelector('.library-browse')?.addEventListener('click', () => { void this.browse(release); });
      const remove = /** @type {HTMLButtonElement|null} */ (article.querySelector('.library-remove'));
      if (remove) {
        remove.disabled = this.busy || this.store.buildStatus === 'building' || this.store.flashStatus === 'flashing' || Boolean(this.store.configurationError);
        remove.addEventListener('click', () => {
          this.store.files.delete('wicro-libraries.lock.json');
          this.store.updateConfiguration({ libraries: requests.filter((/** @type {any} */ entry) => entry !== declaration) });
          this.syncEditor();
          this.status.textContent = 'Dependency removed. The next build resolves the remaining graph; cached packages remain available offline.';
        });
      }
      container.appendChild(article);
    }
  }

  /** @param {import('../../../../packages/registry/src/library-catalog.js').LibraryRelease} release */
  async browse(release) {
    try {
      const result = await this.client.libraries('libraryFiles', { release, offline: this.store.offline });
      const select = /** @type {HTMLSelectElement} */ (this.root.querySelector('#library-file'));
      select.replaceChildren(...result.paths.map((/** @type {string} */ path) => new Option(path, path)));
      /** @type {HTMLElement} */ (this.root.querySelector('#library-preview')).hidden = false;
      const show = async () => {
        try {
          const file = await this.client.libraries('libraryFiles', { release, path: select.value, offline: this.store.offline });
          /** @type {HTMLElement} */ (this.root.querySelector('#library-file-content')).textContent = file.text + (file.truncated ? '\n[Preview truncated at 256 KiB]' : '');
        } catch (error) { this.status.textContent = error instanceof Error ? error.message : String(error); }
      };
      select.onchange = () => { void show(); };
      const readme = result.paths.find((/** @type {string} */ path) => /^readme/i.test(path));
      if (readme) select.value = readme;
      await show();
    } catch (error) { this.status.textContent = error instanceof Error ? error.message : String(error); }
  }
}
