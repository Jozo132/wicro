import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
    assert.match(await readFile(join(directory, 'src', 'main.c'), 'utf8'), /int main/);
  } finally {
    await rm(directory, { recursive: true, force: true });
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

test('planned commands return an explicit exit code', () => {
  const result = run('install', '--json');

  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).implemented, false);
});

test('unknown commands use a usage exit code', () => {
  const result = run('not-a-command', '--json');

  assert.equal(result.status, 64);
  assert.match(result.stdout, /Unknown command/);
});
