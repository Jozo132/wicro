import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskGraph } from '../src/index.js';

test('schedules independent tasks in parallel layers', () => {
  const graph = new TaskGraph();
  graph.add({ id: 'compile-a', run: () => 'a' });
  graph.add({ id: 'compile-b', run: () => 'b' });
  graph.add({ id: 'link', dependencies: ['compile-a', 'compile-b'], run: () => 'firmware' });

  assert.deepEqual(graph.topologicalLayers(), [['compile-a', 'compile-b'], ['link']]);
});

test('rejects unknown dependencies and cycles', () => {
  const unknown = new TaskGraph();
  unknown.add({ id: 'link', dependencies: ['compile'], run: () => undefined });
  assert.throws(() => unknown.validate(), /Unknown task dependencies/);

  const cycle = new TaskGraph();
  cycle.add({ id: 'a', dependencies: ['b'], run: () => undefined });
  cycle.add({ id: 'b', dependencies: ['a'], run: () => undefined });
  assert.throws(() => cycle.validate(), /dependency cycle/);
});

test('executes tasks and returns structured results', async () => {
  const graph = new TaskGraph();
  graph.add({ id: 'compile', run: async () => 'object' });
  graph.add({ id: 'link', dependencies: ['compile'], run: async () => 'firmware' });

  const results = await graph.run();
  assert.equal(results.get('compile'), 'object');
  assert.equal(results.get('link'), 'firmware');
});
