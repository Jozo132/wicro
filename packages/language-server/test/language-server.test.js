import assert from 'node:assert/strict';
import test from 'node:test';
import { WicroLanguageService, WicroLspSession, WicroLanguageWorkerProtocol } from '../src/index.js';

const fakeToolchain = {
  async diagnoseSource() {
    return { exitCode: 1, stdout: '', stderr: 'main.c:1:5: error: unknown identifier\n', diagnostics: [{ severity: 'error', file: 'main.c', line: 1, column: 5, message: 'unknown identifier' }] };
  },
  async completeSource() {
    return { exitCode: 0, stdout: 'COMPLETION: pinMode : [#0#]\n', stderr: '', candidates: [{ label: 'pinMode', detail: '[#0#]' }] };
  },
  async runLanguageTool() {
    throw new Error('Tool WASM entry point is unavailable');
  }
};

test('LSP didOpen publishes real clang diagnostics', async () => {
  const service = new WicroLanguageService({ host: 'node', toolchain: /** @type {any} */ (fakeToolchain) });
  const session = new WicroLspSession(service);
  const response = await session.handle({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: 'file:///main.c', languageId: 'c', version: 1, text: 'int main(void) { bad(); }\n' } }
  });

  assert.equal(response.method, 'textDocument/publishDiagnostics');
  assert.equal(response.params.diagnostics[0].severity, 'error');
  assert.equal(response.params.diagnostics[0].range.start.line, 0);
});

test('completion and cross-document symbol references work', async () => {
  const service = new WicroLanguageService({ host: 'node', toolchain: /** @type {any} */ (fakeToolchain) });
  service.openDocument({ uri: 'file:///main.c', languageId: 'c', version: 1, text: 'int blink(void) { blink(); return 0; }\n' });
  service.openDocument({ uri: 'file:///helper.c', languageId: 'c', version: 1, text: 'void helper(void) { blink(); }\n' });

  const completion = await service.completion('file:///main.c', { line: 0, character: 1 });
  assert.ok(completion.some((item) => item.label === 'pinMode'));

  const references = service.references('file:///main.c', { line: 0, character: 3 });
  assert.ok(references.length >= 2);

  const hover = service.hover('file:///main.c', { line: 0, character: 3 });
  assert.match(hover?.contents.value ?? '', /blink/);
});

test('compile_commands include target, defines and include directories', () => {
  const service = new WicroLanguageService({
    host: 'node',
    toolchain: /** @type {any} */ (fakeToolchain),
    configuration: {
      target: 'riscv32',
      targetOptions: { march: 'rv32imc', mabi: 'ilp32' },
      includeDirs: ['include'],
      defines: ['FIRMWARE=1']
    }
  });
  const commands = service.createCompileCommands({ root: '/project', files: ['main.c'], directory: '/project' });
  assert.equal(commands[0].directory, '/project');
  assert.ok(commands[0].arguments.includes('--target=riscv32-esp-elf'));
  assert.ok(commands[0].arguments.includes('FIRMWARE=1'));
});

test('worker protocol isolates open, change and completion operations', async () => {
  const service = new WicroLanguageService({ host: 'node', toolchain: /** @type {any} */ (fakeToolchain) });
  const worker = new WicroLanguageWorkerProtocol(service);
  const opened = await worker.handle({ id: 1, method: 'language/open', params: { document: { uri: 'file:///main.c', languageId: 'c', text: 'int main(void){return 0;}\n', version: 1 } } });
  assert.equal(opened.ok, true);

  const completion = await worker.handle({ id: 2, method: 'language/completion', params: { uri: 'file:///main.c', position: { line: 0, character: 4 } } });
  assert.equal(completion.ok, true);
});

test('formatting reports unavailable Clang-Format entry point explicitly', async () => {
  const service = new WicroLanguageService({ host: 'node', toolchain: /** @type {any} */ (fakeToolchain) });
  service.openDocument({ uri: 'file:///main.c', languageId: 'c', version: 1, text: 'int main(void){return 0;}\n' });
  await assert.rejects(() => service.format('file:///main.c'), /Clang-Format WASM entry point is unavailable/);
});
