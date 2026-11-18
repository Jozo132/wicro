import assert from 'node:assert/strict';
import test from 'node:test';
import { createManifestValidator, PackageRegistry } from '../src/index.js';

/** @type {import('../src/index.js').WicroPackageManifest} */
const validManifest = {
  name: 'stm32/generic',
  version: '1.2.0',
  kind: 'platform',
  description: 'Generic STM32 platform',
  license: 'Apache-2.0',
  dependencies: {
    arm_gcc: '^13.2.0'
  }
};

test('validates a universal package manifest', async () => {
  const validate = await createManifestValidator();
  assert.equal(validate(validManifest).ok, true);

  assert.equal(validate({ name: 'bad', version: 'nope' }).ok, false);
});

test('resolves the highest matching semantic version', async () => {
  const registry = new PackageRegistry();
  await registry.add(validManifest);
  await registry.add({ ...validManifest, version: '1.3.0' });
  await registry.add({ ...validManifest, version: '2.0.0' });

  assert.equal(registry.resolve('stm32/generic', '^1.0.0')?.version, '1.3.0');
  assert.equal(registry.resolve('stm32/generic', '>=2.0.0 <3.0.0')?.version, '2.0.0');
});

test('rejects duplicate package versions', async () => {
  const registry = new PackageRegistry();
  await registry.add(validManifest);

  await assert.rejects(() => registry.add(validManifest), /already exists/);
});
