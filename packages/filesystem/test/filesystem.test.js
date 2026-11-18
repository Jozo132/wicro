import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryFilesystem } from '../src/index.js';

test('writes and reads files in a virtual root', async () => {
  const filesystem = new MemoryFilesystem();
  await filesystem.writeFile('/project/main.c', 'int main(void) { return 0; }');

  assert.equal(await filesystem.readFile('/project/main.c'), 'int main(void) { return 0; }');
  assert.deepEqual(await filesystem.readdir('/'), ['project']);
  assert.deepEqual(await filesystem.readdir('/project'), ['main.c']);
});

test('normalizes dot segments and rejects root escape', async () => {
  const filesystem = new MemoryFilesystem();
  await filesystem.writeFile('/project/./src/../main.c', 'ok');

  assert.equal(await filesystem.readFile('/project/main.c'), 'ok');
  await assert.rejects(() => filesystem.readFile('/../../secret'), /escapes the filesystem root/);
});

test('removes files and nested directories', async () => {
  const filesystem = new MemoryFilesystem();
  await filesystem.writeFile('/cache/a.txt', 'a');
  await filesystem.writeFile('/cache/nested/b.txt', 'b');

  await filesystem.remove('/cache');

  assert.equal(await filesystem.exists('/cache'), false);
  assert.equal(await filesystem.exists('/cache/a.txt'), false);
});
