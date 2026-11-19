import assert from 'node:assert/strict';
import test from 'node:test';
import { VSCodeHostAdapter } from '../src/index.js';

test('VS Code host lists registered boards', async () => {
  const host = new VSCodeHostAdapter({ workspaceRoot: process.cwd() });
  const boards = await host.boardList();

  assert.ok(boards.some((board) => board.name === 'stm32f103cb'));
  assert.ok(boards.some((board) => board.name === 'stm32h723vg'));
});

test('VS Code host exposes compile and device commands', () => {
  const host = new VSCodeHostAdapter({ workspaceRoot: process.cwd() });

  assert.deepEqual(host.commands(), [
    'wicro.boardList',
    'wicro.compileSource',
    'wicro.compileBareMetal',
    'wicro.deviceList'
  ]);
});
