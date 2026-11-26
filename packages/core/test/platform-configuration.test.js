import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { IdeStore } from '../../../apps/web/src/state/ide-store.js';
import { getDeviceFamily, getTargetConfiguration, OPTIMIZATIONS, setOptimization, validatePlatformConfiguration } from '../src/platform/configuration.js';

const root = new URL('../../../registry/', import.meta.url);
/** @type {import('../../../apps/web/src/state/ide-store.js').BoardCatalogEntry[]} */
const boards = [];
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifest = JSON.parse(await readFile(new URL(`${entry.name}/package.json`, root), 'utf8'));
  if (manifest.kind === 'board') boards.push({ ...manifest, id: entry.name });
}
const createStore = () => {
  const store = new IdeStore();
  store.setBoards(boards);
  store.loadExample({ id: 'custom', name: 'custom', board: 'esp32-c3-supermini', framework: 'arduino', files: {
    'main.c': 'int main(void) { return 0; }',
    'wicro.json': JSON.stringify({ name: 'custom', board: 'esp32-c3-supermini', framework: 'arduino', packages: { custom: '^1.0.0' }, build: { sources: ['main.c'], flags: ['-std=gnu++17', '-Os'], customSetting: 42 } })
  } });
  return store;
};

test('all board/framework/optimization combinations resolve through one configuration model', () => {
  const store = createStore();
  for (const board of boards) {
    store.setBoard(board.id);
    assert.ok(getDeviceFamily(board));
    const target = getTargetConfiguration(board);
    for (const framework of target.frameworks) {
      store.setFramework(framework);
      for (const optimization of OPTIMIZATIONS) {
        store.updateBuildConfiguration({ flags: setOptimization(store.configuration.build.flags, optimization) });
        assert.deepEqual(store.configurationIssues, [], `${board.id}/${framework}/${optimization}`);
        assert.equal(store.configuration.build.flags.filter((/** @type {string} */ flag) => OPTIMIZATIONS.includes(flag)).length, 1);
      }
    }
    assert.equal(store.files.get('main.c'), 'int main(void) { return 0; }');
    assert.equal(store.configuration.packages.custom, '^1.0.0');
    assert.equal(store.configuration.build.customSetting, 42);
    assert.deepEqual(store.configuration.build.sources, ['main.c']);
    if (!target.browserUpload) assert.equal(store.uploadSettings.programmer, 'none');
  }
});

test('manual JSON updates visual state, rejects malformed values and recovers without data loss', () => {
  const store = createStore();
  const configuration = { name: 'manual', board: 'stm32f103cb', framework: 'bare-metal', build: { flags: ['-O2', '-g'], defines: ['CUSTOM=9'] } };
  store.setFileContent('wicro.json', JSON.stringify(configuration));
  assert.equal(store.boardId, 'stm32f103cb');
  assert.equal(store.framework, 'bare-metal');
  assert.equal(store.uploadSettings.programmer, 'stm32-cdc-dfu');
  store.setFileContent('wicro.json', '{ "board":');
  assert.ok(store.configurationError);
  store.setBoard('esp32-c3-supermini');
  assert.equal(store.files.get('wicro.json'), '{ "board":');
  store.setFileContent('wicro.json', JSON.stringify(configuration));
  assert.deepEqual(store.configurationIssues, []);
  for (const build of [null, [], 'invalid', { flags: 'not an array' }, { defines: [5] }, { clockHz: 200000000 }]) {
    assert.ok(validatePlatformConfiguration({ ...configuration, build }, boards).length);
  }
  assert.ok(validatePlatformConfiguration({ ...configuration, upload: { programmer: 'esp32-c3-usb-jtag' } }, boards).length);
});

test('upload choices persist to JSON and preserve firmware while build changes invalidate it', () => {
  const store = createStore();
  store.lastBuild = { ok: true };
  store.updateUploadConfiguration({ verify: 'none', autoMonitor: false, baudRate: 230400, monitorBaudRate: 57600 });
  assert.equal(store.lastBuild?.ok, true);
  assert.equal(store.verifyReadback, false);
  assert.equal(store.autoMonitorAfterFlash, false);
  assert.equal(store.baudRate, 57600);
  const json = JSON.parse(store.files.get('wicro.json') ?? '{}');
  assert.equal(json.upload.baudRate, 230400);
  store.updateBuildConfiguration({ flags: ['-O0'] });
  assert.equal(store.lastBuild, null);
  store.updateUploadConfiguration({ baudRate: -1 });
  assert.match(store.configurationIssues.join(' '), /baudRate/);
  store.setBoard('stm32f103cb');
  assert.equal(store.configuration.upload, undefined);
  assert.equal(store.uploadSettings.programmer, 'stm32-cdc-dfu');
});
