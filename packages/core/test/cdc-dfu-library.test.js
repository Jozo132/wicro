import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectLibrary } from '../../registry/src/libraries.js';
import { createLibraryCompilePlan, validateLibraryCompileConfiguration } from '../src/project-libraries.js';

const encode = new TextEncoder();
/** @type {import('../../registry/src/library-catalog.js').LibraryRelease} */
const release = {
  id: 'platformio:jozo132/cdc-dfu', provider: 'platformio', owner: 'jozo132', name: 'cdc-dfu', version: '1.1.2',
  sha256: '64911fd4004b4fc8e311fb55cfc06e0d7f5fd2f8fc215c1d22480d92e13e3afe'
};
// Metadata format fixture exercises the reviewed recipe selection; archive
// checksum verification belongs to LibraryManager before this inspection.
const files = {
  'library.json': encode.encode(JSON.stringify({ name: 'cdc-dfu', version: '1.1.2', build: { flags: '-D DTR_TOGGLING_SEQ', extraScript: 'extra_script.py', libArchive: false, srcFilter: '-<*>' } })),
  'src/cdc_dfu.cpp': encode.encode('#include "cdc_dfu.h"'),
  'src/cdc_dfu.h': encode.encode('#pragma once')
};
test('only the reviewed CDC-DFU release enables the explicit hook translation', () => {
  assert.throws(() => inspectLibrary(files), /Python\/SCons/);
  assert.throws(() => inspectLibrary(files, { ...release, version: '1.1.3' }), /Python\/SCons/);
  assert.throws(() => inspectLibrary(files, { ...release, owner: 'someone-else' }), /Python\/SCons/);
  assert.throws(() => inspectLibrary(files, { ...release, sha256: '0'.repeat(64) }), /Python\/SCons/);
  const plan = createLibraryCompilePlan([{ release, files }]);
  assert.deepEqual(plan.recipes, ['cdc-dfu-1.1.2']);
  assert.deepEqual(plan.globalDefines, ['DTR_TOGGLING_SEQ']);
  assert.equal(plan.units.length, 1, 'source is forced into linking despite the upstream exclusion filter');
  assert.match(plan.units[0].path, /src\/cdc_dfu.cpp$/);
});

test('CDC-DFU cannot silently compile an empty hook for an incompatible framework', () => {
  const plan = { recipes: ['cdc-dfu-1.1.2'] };
  const defines = ['STM32F4xx', 'USBCON', 'USBD_USE_CDC'];
  assert.doesNotThrow(() => validateLibraryCompileConfiguration(plan, 'arduino', defines));
  assert.doesNotThrow(() => validateLibraryCompileConfiguration(plan, 'arduino', ['STM32H7xx', 'USBCON=1', 'USBD_USE_CDC=1']));
  assert.throws(() => validateLibraryCompileConfiguration(plan, 'bare-metal', defines), /compile empty/);
  assert.throws(() => validateLibraryCompileConfiguration(plan, 'arduino', defines.slice(1)), /compile empty/);
  assert.throws(() => validateLibraryCompileConfiguration(plan, 'arduino', defines.slice(0, 2)), /compile empty/);
});
