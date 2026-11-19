import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const cli = new URL('../bin/wicro.js', import.meta.url);

/** @param {string[]} args */
const run = (...args) => {
  return spawnSync(process.execPath, [cli.pathname, ...args], { encoding: 'utf8' });
};

/** @param {string} cwd @param {string[]} args */
const runIn = (cwd, ...args) => {
  return spawnSync(process.execPath, [cli.pathname, ...args], { encoding: 'utf8', cwd });
};

test('--help prints usage', () => {
  const result = run('--help');

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Wicro 0\.1\.0/);
  assert.match(result.stdout, /--version/);
});

test('--version prints the package version', () => {
  const result = run('--version');

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '0.1.0\n');
});

test('init creates a project manifest and source entry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wicro-init-'));

  try {
    const result = runIn(directory, 'init', '--json');
    assert.equal(result.status, 0);

    const manifest = JSON.parse(await readFile(join(directory, 'wicro.json'), 'utf8'));
    assert.equal(manifest.name, 'wicro-project');
    assert.equal(manifest.board, 'arduino-uno-original');
    assert.equal(manifest.framework, 'arduino');
    assert.match(await readFile(join(directory, 'src', 'main.ino'), 'utf8'), /void setup|void loop/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('import creates an Arduino-first project from a directory', async () => {
  const source = await mkdtemp(join(tmpdir(), 'wicro-import-source-'));
  const destinationRoot = await mkdtemp(join(tmpdir(), 'wicro-import-root-'));

  try {
    await mkdir(join(source, 'src'), { recursive: true });
    await writeFile(join(source, 'src', 'main.ino'), 'void setup() {}\nvoid loop() {}\n');
    const dest = join(destinationRoot, 'demo');
    const result = runIn(destinationRoot, 'import', source, '--dest=demo', '--json');
    assert.equal(result.status, 0);

    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.framework, 'arduino');
    const manifest = JSON.parse(await readFile(join(dest, 'wicro.json'), 'utf8'));
    assert.equal(manifest.framework, 'arduino');
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(destinationRoot, { recursive: true, force: true });
  }
});

test('doctor emits machine-readable host information', () => {
  const result = run('doctor', '--json');

  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.command, 'doctor');
  assert.equal(report.wasmAvailable, true);
});

test('board list returns registered boards', () => {
  const result = runIn(resolve(process.cwd()), 'board', 'list', '--json');

  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.implemented, true);
  assert.ok(report.items.some((/** @type {{name:string}} */ item) => item.name === 'stm32f103cb'));
  assert.ok(report.items.some((/** @type {{name:string}} */ item) => item.name === 'stm32h723vg'));
});

test('package list returns registry packages', () => {
  const result = runIn(resolve(process.cwd()), 'package', 'list', '--json');

  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.implemented, true);
  assert.ok(report.items.some((/** @type {{name:string}} */ item) => item.name === 'stm32f103cb'));
});

test('install, update and uninstall manage registry packages and a lockfile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wicro-packages-'));

  try {
    const install = runIn(directory, 'install', 'stm32f103cb', '--json');
    assert.equal(install.status, 0);
    const installReport = JSON.parse(install.stdout);
    assert.equal(installReport.ok, true);
    assert.equal(installReport.implemented, true);
    assert.ok(installReport.packages.some((/** @type {{name:string}} */ item) => item.name === 'stm32f103cb'));

    const lock = JSON.parse(await readFile(join(directory, '.wicro', 'wicro-lock.json'), 'utf8'));
    assert.equal(lock.lockfileVersion, 1);
    assert.ok(lock.packages['stm32f103cb']);

    const update = runIn(directory, 'update', 'stm32f103cb', '--json');
    assert.equal(update.status, 0);
    assert.equal(JSON.parse(update.stdout).ok, true);

    const uninstall = runIn(directory, 'uninstall', 'stm32f103cb', '--json');
    assert.equal(uninstall.status, 0);
    assert.equal(JSON.parse(uninstall.stdout).ok, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unknown commands use a usage exit code', () => {
  const result = run('not-a-command', '--json');

  assert.equal(result.status, 64);
  assert.match(result.stdout, /Unknown command/);
});
