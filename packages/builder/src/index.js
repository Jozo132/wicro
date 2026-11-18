/**
 * @typedef {object} BuildTask
 * @property {string} id
 * @property {string[]} [dependencies]
 * @property {() => Promise<unknown>|unknown} run
 */

export class TaskGraph {
  constructor() {
    /** @type {Map<string, BuildTask>} */
    this.tasks = new Map();
  }

  /** @param {BuildTask} task */
  add(task) {
    if (typeof task.id !== 'string' || task.id.length === 0) throw new Error('A task id is required');
    if (typeof task.run !== 'function') throw new Error(`Task '${task.id}' requires a run function`);
    if (this.tasks.has(task.id)) throw new Error(`Task already exists: ${task.id}`);

    this.tasks.set(task.id, {
      id: task.id,
      dependencies: [...(task.dependencies ?? [])],
      run: task.run
    });
  }

  validate() {
    const unknown = [];

    for (const task of this.tasks.values()) {
      for (const dependency of task.dependencies ?? []) {
        if (!this.tasks.has(dependency)) unknown.push(`${task.id} -> ${dependency}`);
      }
    }

    if (unknown.length > 0) throw new Error(`Unknown task dependencies: ${unknown.join(', ')}`);

    const visiting = new Set();
    const visited = new Set();

    /** @param {BuildTask} task */
    const visit = (task) => {
      if (visiting.has(task.id)) throw new Error(`Task dependency cycle detected at '${task.id}'`);
      if (visited.has(task.id)) return;

      visiting.add(task.id);
      for (const dependency of task.dependencies ?? []) {
        const parent = this.tasks.get(dependency);
        if (parent) visit(parent);
      }
      visiting.delete(task.id);
      visited.add(task.id);
    };

    for (const task of this.tasks.values()) visit(task);
  }

  /** @returns {string[][]} */
  topologicalLayers() {
    this.validate();
    const remaining = new Map([...this.tasks].map(([id, task]) => [id, task]));
    const completed = new Set();
    const layers = [];

    while (remaining.size > 0) {
      const ready = [...remaining.values()]
        .filter((task) => (task.dependencies ?? []).every((dependency) => completed.has(dependency)))
        .map((task) => task.id);

      if (ready.length === 0) throw new Error('Unable to schedule build tasks');
      layers.push(ready);

      for (const id of ready) {
        remaining.delete(id);
        completed.add(id);
      }
    }

    return layers;
  }

  async run() {
    const results = new Map();

    for (const layer of this.topologicalLayers()) {
      const settled = await Promise.all(layer.map(async (id) => {
        const task = this.tasks.get(id);
        if (!task) throw new Error(`Task disappeared during execution: ${id}`);
        return [id, await task.run()];
      }));

      for (const [id, value] of settled) results.set(/** @type {string} */ (id), value);
    }

    return results;
  }
}
