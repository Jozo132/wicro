import { getDeviceFamily, getTargetConfiguration, OPTIMIZATIONS, setOptimization, toggleBuildFlag } from '../../../../packages/core/src/platform/configuration.js';

/** @param {unknown} value */
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
/** @param {string} id @param {string} label @param {string} content */
const field = (id, label, content) => `<label class="config-field" for="${id}"><span>${label}</span>${content}</label>`;
/** @param {string} id @param {Array<{value:string,label:string,disabled?:boolean}>} choices @param {unknown} current @param {boolean} [disabled] */
const select = (id, choices, current, disabled = false) => {
  const values = [...choices];
  if (current !== undefined && !values.some((choice) => choice.value === String(current))) values.push({ value: String(current), label: `${String(current)} (unsupported)` });
  return `<select id="${id}" ${disabled ? 'disabled' : ''}>${values.map((choice) => `<option value="${escape(choice.value)}" ${choice.value === String(current) ? 'selected' : ''} ${choice.disabled ? 'disabled' : ''}>${escape(choice.label)}</option>`).join('')}</select>`;
};
/** @param {string} id @param {string} label @param {boolean} checked */
const check = (id, label, checked) => `<label class="config-check"><input id="${id}" type="checkbox" ${checked ? 'checked' : ''}>${label}</label>`;
/** @param {string[]} values */
const choices = (values) => values.map((value) => ({ value, label: value }));

export class PlatformConfigurationPanel {
  /** @param {HTMLElement} root @param {import('../state/ide-store.js').IdeStore} store @param {{webSerial:boolean,webUsb?:boolean,onEnterDfu?:()=>void,onEnterRom?:()=>void,onEditJson:()=>void}} options */
  constructor(root, store, options) {
    this.root = root;
    this.store = store;
    this.options = options;
    this.store.subscribe((changed) => {
      if (['all', 'boards', 'project', 'configuration', 'file-content', 'build', 'flash'].includes(changed)) this.render();
    });
    this.render();
  }

  render() {
    const sections = new Map([...this.root.querySelectorAll('details')].map((element) => [element.id, element.open]));
    const scrollTop = this.root.scrollTop;
    const focusId = this.root.contains(document.activeElement) ? document.activeElement?.id : null;
    const config = this.store.configuration;
    const board = this.store.currentBoard;
    const target = getTargetConfiguration(board);
    const family = board ? getDeviceFamily(board) : '';
    const model = String(board?.metadata.mcu ?? '');
    const families = [...new Set(this.store.boards.map(getDeviceFamily))].sort();
    const familyBoards = this.store.boards.filter((entry) => getDeviceFamily(entry) === family);
    const models = [...new Set(familyBoards.map((entry) => String(entry.metadata.mcu ?? entry.id)))].sort();
    const modelBoards = familyBoards.filter((entry) => String(entry.metadata.mcu ?? entry.id) === model);
    const flags = Array.isArray(config.build?.flags) ? config.build.flags.filter((/** @type {unknown} */ value) => typeof value === 'string') : [];
    const defines = Array.isArray(config.build?.defines) ? config.build.defines : [];
    const optimization = flags.filter((/** @type {string} */ flag) => OPTIMIZATIONS.includes(flag)).at(-1) ?? '';
    const upload = this.store.uploadSettings;
    const dfu = target.protocol === 'dfuse';
    const esp8266 = target.programmer?.id === 'esp8266-uart';
    const nano = target.programmer?.id === 'nano-stk500v1';
    const originalEsp32 = target.programmer?.id === 'esp32-original-uart';
    const picoboot = target.protocol === 'picoboot';
    const canUpload = dfu || picoboot ? this.options.webUsb : this.options.webSerial;
    const uploading = upload.programmer !== 'none' && target.browserUpload;
    const busy = this.store.buildStatus === 'building' || this.store.flashStatus === 'flashing';
    const issues = this.store.configurationIssues;
    this.root.innerHTML = `
      <div class="config-heading"><div><span class="config-eyebrow">QUICK CONFIGURATION</span><h2>Platform setup</h2></div><button type="button" id="config-close" class="btn-tiny" aria-label="Close platform setup">×</button></div>
      <div class="config-summary"><strong>${escape(model || 'Choose a device')}</strong><span>${escape(target.architecture)} · ${target.buildKind === 'object' ? 'Object build' : 'Firmware build'}</span></div>
      <div id="config-errors" class="config-errors" role="status" ${issues.length ? '' : 'hidden'}>${issues.map((issue) => `<p>${escape(issue)}</p>`).join('')}</div>
      <fieldset class="config-form" ${busy || this.store.configurationError ? 'disabled' : ''}>
        <details id="config-target-section" open><summary>01 <span>Device & framework</span></summary><div class="config-fields">
          ${field('config-family', 'Device family', select('config-family', choices(families), family))}
          ${field('config-model', 'MCU model', select('config-model', choices(models), model))}
          ${field('config-board', 'Board preset', select('config-board', modelBoards.map((entry) => ({ value: entry.id, label: entry.id })), this.store.boardId))}
          ${field('config-framework', 'Framework', select('config-framework', choices(target.frameworks), this.store.framework))}
          ${field('config-clock', 'CPU frequency', select('config-clock', [{ value: String(target.clockHz ?? ''), label: target.clockHz ? `${target.clockHz / 1000000} MHz · recipe default` : 'Defined by SDK / startup' }], String(target.clockHz ?? ''), true))}
          <p class="config-help">Clock and overclock control require a board-specific startup or SDK recipe. This preset does not expose an adjustable clock.</p>
          <p class="config-help">${target.buildKind === 'object' ? 'This preset compiles objects; complete firmware linking is not available.' : 'Uses the selected board’s firmware recipe and linker configuration.'}</p>
        </div></details>
        <details id="config-build-section" open><summary>02 <span>Build options</span></summary><div class="config-fields">
          ${field('config-optimization', 'Optimization', select('config-optimization', [{ value: '', label: 'Recipe default' }, ...OPTIMIZATIONS.map((value) => ({ value, label: ({ '-O0': 'None · -O0', '-Og': 'Debug friendly · -Og', '-Os': 'Small code · -Os', '-Oz': 'Smallest code · -Oz' })[value] ?? value }))], optimization))}
          ${check('config-debug', 'Include debug symbols (-g)', flags.includes('-g'))}
          ${check('config-warnings', 'Enable common warnings (-Wall)', flags.includes('-Wall'))}
          ${check('config-extra-warnings', 'Enable extra warnings (-Wextra)', flags.includes('-Wextra'))}
          ${field('config-defines', 'Preprocessor defines', `<textarea id="config-defines" rows="3" spellcheck="false" placeholder="FEATURE_ENABLED=1&#10;LOG_LEVEL=2">${escape(defines.join('\n'))}</textarea>`)}
          <p class="config-help">One define per line, without -D.</p>
          <details id="config-advanced-section" class="config-advanced"><summary>Additional compiler flags</summary>${field('config-flags', 'Flags · one argument per line', `<textarea id="config-flags" rows="4" spellcheck="false">${escape(flags.join('\n'))}</textarea>`)}</details>
        </div></details>
        <details id="config-upload-section" open><summary>03 <span>Programmer & upload</span></summary><div class="config-fields">
          ${field('config-programmer', 'Programmer', select('config-programmer', [{ value: 'none', label: 'Download artifacts only' }, ...(target.programmer ? [{ value: target.programmer.id, label: target.programmer.name, disabled: !target.browserUpload || !canUpload }] : [])], upload.programmer))}
          ${!target.browserUpload ? '<p class="config-help">No browser upload adapter is available for this preset. Download artifacts for an external programmer.</p>' : !canUpload ? '<p class="config-help">The required USB API is unavailable in this browser.</p>' : ''}
          <div id="config-upload-fields" ${uploading ? '' : 'hidden'}>
            ${field('config-protocol', 'Upload protocol', select('config-protocol', [{ value: target.protocol ?? '', label: picoboot ? 'RP2040 ROM USB PICOBOOT' : dfu ? 'STM32 USB DfuSe' : nano ? 'AVR STK500v1' : 'Espressif ROM / stub (SLIP)' }], upload.protocol))}
            ${nano ? field('config-upload-baud', 'Bootloader / upload speed', select('config-upload-baud', [{ value: '115200', label: '115200 · current bootloader' }, { value: '57600', label: '57600 · old bootloader' }], upload.baudRate)) : dfu || picoboot ? '' : field('config-upload-baud', 'Upload baud rate', `<input id="config-upload-baud" ${esp8266 || originalEsp32 ? 'disabled' : ''} type="number" min="1" max="2000000" step="1" value="${escape(upload.baudRate)}">`)}
            ${dfu || picoboot || esp8266 || originalEsp32 || nano ? '<p class="config-help">Verification: byte-for-byte flash readback (required).</p>' : check('config-verify', 'Verify after upload', upload.verify !== 'none')}
            <div id="config-verification-fields" ${upload.verify !== 'none' ? '' : 'hidden'}>${field('config-verification', 'Verification protocol', select('config-verification', [{ value: 'readback', label: 'Byte-for-byte flash readback' }], upload.verify === 'none' ? 'readback' : upload.verify))}</div>
            ${picoboot ? '<p class="config-help">This firmware uses vendor USB diagnostics.</p>' : dfu ? '<p class="config-help">Monitor reconnect is manual after USB re-enumeration.</p>' : check('config-auto-monitor', 'Open serial monitor after upload', upload.autoMonitor)}
            <div id="config-monitor-fields" ${upload.autoMonitor && !dfu && !picoboot ? '' : 'hidden'}>${field('config-monitor-baud', 'Monitor baud rate', `<input id="config-monitor-baud" type="number" min="1" max="2000000" step="1" value="${escape(upload.monitorBaudRate)}">`)}</div>
            ${picoboot ? '<p class="config-help">RP2040-Zero · 2 MiB flash · BOOT + reset for first upload. Runtime uses vendor USB diagnostics, not a tty serial port. Readback is required.</p><button id="config-enter-rp-rom" type="button" class="btn-tiny">Enter ROM through USB</button>' : dfu ? '<p class="config-help">F401RC: flash 0x08000000, 256 KiB. Flash requires ROM DFU. Use BOOT0/reset for first provisioning; the CDC trigger requires bridge-enabled firmware. Readback is mandatory.</p><button id="config-enter-dfu" type="button" class="btn-tiny">Enter DFU through CDC</button>' : nano ? '<p class="config-help">ATmega328P · 128-byte flash pages · 30 KiB application limit · bootloader preserved.</p>' : originalEsp32 ? '<p class="config-help">Original ESP32 LX6 · RAM-only boot image at 0x1000 · 4 MiB / 40 MHz crystal · 115200 baud. Replaces the existing bootloader.</p>' : esp8266 ? '<p class="config-help">UART DTR/RTS reset · RAM-only ROM image at flash offset 0 · 4 MiB board profile · 115200 baud.</p>' : '<p class="config-help">USB Serial/JTAG CDC reset · application partition at 0x10000.</p>'}
          </div>
        </div></details>
      </fieldset>
      <div class="config-footer"><span>Synced with wicro.json</span><button id="config-edit-json" class="btn-tiny" type="button">Edit JSON ↗</button></div>`;
    for (const element of this.root.querySelectorAll('details')) {
      if (sections.has(element.id)) element.open = Boolean(sections.get(element.id));
    }
    const trigger = this.root.querySelector('#config-enter-dfu');
    if (trigger) /** @type {HTMLButtonElement} */ (trigger).disabled = !this.options.webSerial;
    this.bindEvents(flags);
    if (focusId) /** @type {HTMLElement|null} */ (this.root.querySelector(`#${focusId}`))?.focus({ preventScroll: true });
    this.root.scrollTop = scrollTop;
  }

  /** @param {string[]} flags */
  bindEvents(flags) {
    /** @param {string} id @param {(element:HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement)=>void} callback */
    const change = (id, callback) => this.root.querySelector(`#${id}`)?.addEventListener('change', (event) => callback(/** @type {HTMLInputElement} */ (event.target)));
    /** @param {string} text */
    const lines = (text) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    change('config-family', (input) => {
      const board = this.store.boards.find((entry) => getDeviceFamily(entry) === input.value);
      if (board) this.store.setBoard(board.id);
    });
    change('config-model', (input) => {
      const family = this.store.currentBoard ? getDeviceFamily(this.store.currentBoard) : '';
      const board = this.store.boards.find((entry) => getDeviceFamily(entry) === family && String(entry.metadata.mcu ?? entry.id) === input.value);
      if (board) this.store.setBoard(board.id);
    });
    change('config-board', (input) => this.store.setBoard(input.value));
    change('config-framework', (input) => this.store.setFramework(input.value));
    change('config-optimization', (input) => this.store.updateBuildConfiguration({ flags: setOptimization(flags, input.value) }));
    for (const [id, flag] of [['config-debug', '-g'], ['config-warnings', '-Wall'], ['config-extra-warnings', '-Wextra']]) {
      change(id, (input) => this.store.updateBuildConfiguration({ flags: toggleBuildFlag(flags, flag, /** @type {HTMLInputElement} */ (input).checked) }));
    }
    change('config-defines', (input) => this.store.updateBuildConfiguration({ defines: lines(input.value) }));
    change('config-flags', (input) => this.store.updateBuildConfiguration({ flags: lines(input.value) }));
    change('config-programmer', (input) => this.store.updateUploadConfiguration({ programmer: input.value }));
    change('config-protocol', (input) => this.store.updateUploadConfiguration({ protocol: input.value }));
    change('config-upload-baud', (input) => this.store.updateUploadConfiguration({ baudRate: Number(input.value) }));
    change('config-verify', (input) => this.store.updateUploadConfiguration({ verify: /** @type {HTMLInputElement} */ (input).checked ? 'readback' : 'none' }));
    change('config-verification', (input) => this.store.updateUploadConfiguration({ verify: input.value }));
    change('config-auto-monitor', (input) => this.store.updateUploadConfiguration({ autoMonitor: /** @type {HTMLInputElement} */ (input).checked }));
    change('config-monitor-baud', (input) => this.store.updateUploadConfiguration({ monitorBaudRate: Number(input.value) }));
    this.root.querySelector('#config-enter-rp-rom')?.addEventListener('click', () => this.options.onEnterRom?.());
    this.root.querySelector('#config-enter-dfu')?.addEventListener('click', () => this.options.onEnterDfu?.());
    this.root.querySelector('#config-edit-json')?.addEventListener('click', this.options.onEditJson);
    this.root.querySelector('#config-close')?.addEventListener('click', () => { this.root.hidden = true; document.querySelector('#wicro-configure')?.setAttribute('aria-expanded', 'false'); });
  }
}
