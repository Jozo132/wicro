import { createRequire } from 'node:module';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

export const version = packageJson.version;

export const help = () => {
  return `Wicro ${version}\n\nUsage:\n  wicro <command> [options]\n\nCommands:\n  init [name]       Create a Wicro project\n  build             Build firmware with the Node ESP-IDF host adapter\n  rebuild           Rebuild firmware\n  clean             Remove Wicro build and cache directories\n  upload            Upload an ESP32-C3 firmware image\n  monitor           Monitor the ESP32-C3 serial console\n  install           Install package dependencies (planned)\n  uninstall         Remove package dependencies (planned)\n  update            Update package dependencies (planned)\n  board list        List available boards\n  device list       List detected ESP32-C3 devices\n  package list      List registry packages\n  doctor            Inspect the Node.js host environment\n  test              Run workspace tests\n\nOptions:\n  -h, --help        Show this help message\n  -V, --version     Show the version\n      --json        Emit machine-readable JSON\n`;
};

/**
 * @param {unknown} value
 * @param {boolean} json
 * @param {string} text
 */
const emit = (value, json, text) => {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`);
};

/** @param {string[]} args */
export const main = async (args = []) => {
  const json = args.includes('--json');
  const flags = args.filter((arg) => arg !== '--json');

  if (flags.includes('--help') || flags.includes('-h')) {
    process.stdout.write(help());
    return 0;
  }

  if (flags.includes('--version') || flags.includes('-V')) {
    process.stdout.write(`${version}\n`);
    return 0;
  }

  if (flags.length === 0) {
    process.stdout.write(help());
    return 0;
  }

  const command = flags[0];

  if (command === 'init') {
    const force = flags.includes('--force');
    const name = flags.slice(1).find((arg) => !arg.startsWith('--'));
    const target = name ? resolve(process.cwd(), name) : process.cwd();

    try {
      await mkdir(resolve(target, 'src'), { recursive: true });
      const manifest = {
        $schema: 'https://wicro.dev/schemas/project.schema.json',
        name: name ?? 'wicro-project',
        board: '',
        framework: '',
        toolchain: ''
      };
      await writeFile(resolve(target, 'wicro.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: force ? 'w' : 'wx' });
      await writeFile(resolve(target, 'src', 'main.c'), '#include <stdint.h>\n\nint main(void) {\n  return 0;\n}\n', { flag: 'wx' });

      emit({ ok: true, command: 'init', path: target, manifest: 'wicro.json' }, json, `Initialized Wicro project at ${target}`);
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!json) process.stderr.write(`Wicro init failed: ${message}\n`);
      else process.stderr.write(`${JSON.stringify({ ok: false, command: 'init', error: message })}\n`);
      return 1;
    }
  }

  if (command === 'build' || command === 'rebuild') {
    const project = flags.find((arg) => arg.startsWith('--project='))?.slice('--project='.length) ?? 'examples/esp32-c3-supermini/blink';
    const target = resolve(project);

    if (project.includes('esp8266')) {
      const build = spawnSync('arduino-cli', ['compile', '--fqbn', 'esp8266:esp8266:generic', target], {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8'
      });
      if (build.error) {
        emit({ ok: false, command, error: build.error.message }, json, `Build failed: ${build.error.message}`);
        return 1;
      }
      if (build.status !== 0) {
        emit({ ok: false, command, status: build.status, stderr: build.stderr }, json, build.stderr || 'ESP8266 Arduino build failed');
        return build.status ?? 1;
      }
      emit({ ok: true, command, adapter: 'arduino-cli', path: target, stdout: build.stdout }, json, `Built ${target}`);
      return 0;
    }

    const idfRoot = resolve('toolchain/esp32-c3/esp-idf');
    const python = resolve(process.env.HOME ?? '', '.espressif/python_env/idf6.1_py3.12_env/bin/python');
    const idfPy = resolve(idfRoot, 'tools/idf.py');
    const idfTarget = project.includes('esp32-original') ? 'esp32' : 'esp32c3';
    const env = {
      ...process.env,
      IDF_PATH: idfRoot,
      IDF_PYTHON_ENV_PATH: resolve(process.env.HOME ?? '', '.espressif/python_env/idf6.1_py3.12_env'),
      ESP_IDF_VERSION: '6.1.1'
    };
    const build = spawnSync(python, [idfPy, 'set-target', idfTarget, 'build'], {
      cwd: target,
      env,
      encoding: 'utf8'
    });

    if (build.error) {
      emit({ ok: false, command, error: build.error.message }, json, `Build failed: ${build.error.message}`);
      return 1;
    }
    if (build.status !== 0) {
      emit({ ok: false, command, status: build.status, stderr: build.stderr }, json, build.stderr || 'ESP-IDF build failed');
      return build.status ?? 1;
    }

    emit({ ok: true, command, adapter: 'esp-idf-native-reference', target: idfTarget, path: target, stdout: build.stdout }, json, `Built ${target}`);
    return 0;
  }

  if (command === 'clean') {
    const cwd = process.cwd();
    await rm(resolve(cwd, '.wicro/build'), { recursive: true, force: true });
    await rm(resolve(cwd, '.wicro/cache'), { recursive: true, force: true });
    emit({ ok: true, command: 'clean' }, json, 'Removed Wicro build and cache directories');
    return 0;
  }

  if (command === 'doctor') {
    const report = {
      ok: true,
      command: 'doctor',
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      wasmAvailable: typeof WebAssembly !== 'undefined',
      cwd: process.cwd(),
      nativeToolchainsRequired: false
    };
    emit(report, json, `Wicro doctor\n  Node.js: ${process.version}\n  Platform: ${process.platform}/${process.arch}\n  WebAssembly: available\n  Native toolchains required: no`);
    return 0;
  }

  if (command === 'board' && flags[1] === 'list') {
    try {
      const { readdir, readFile } = await import('node:fs/promises');
      const registryRoot = resolve(new URL('../../../registry', import.meta.url).pathname);
      const names = await readdir(registryRoot);
      const items = [];
      for (const name of names) {
        try {
          const manifest = JSON.parse(await readFile(resolve(registryRoot, name, 'package.json'), 'utf8')); 
          if (manifest.kind === 'board') items.push({ name: manifest.name, mcu: manifest.metadata?.mcu, architecture: manifest.metadata?.architecture });
        } catch {
          // Ignore registry entries that are not boards.
        }
      }
      items.sort((left, right) => left.name.localeCompare(right.name));
      emit({ ok: true, command: 'board list', implemented: true, items }, json,
        items.map((item) => `${item.name}: ${item.mcu} (${item.architecture})`).join('\n'));
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ ok: false, command: 'board list', implemented: false, error: message }, json, `Board registry unavailable: ${message}`);
      return 1;
    }
  }

  if (command === 'device' && flags[1] === 'list') {
    try {
      const { NodeSerialHost } = await import('../../hardware/src/index.js');
      const items = await new NodeSerialHost().discover();
      emit({ ok: true, command: 'device list', implemented: true, items }, json,
        items.map((item) => `${item.path}${item.manufacturer ? ` (${item.manufacturer})` : ''}`).join('\n') || 'No serial devices found');
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ ok: false, command: 'device list', implemented: false, error: message }, json,
        `No device host is available: ${message}`);
      return 1;
    }
  }

  if (command === 'package' && flags[1] === 'list') {
    try {
      const { readdir, readFile } = await import('node:fs/promises');
      const registryRoot = resolve(new URL('../../../registry', import.meta.url).pathname);
      const names = await readdir(registryRoot);
      const items = [];
      for (const name of names) {
        try {
          const manifest = JSON.parse(await readFile(resolve(registryRoot, name, 'package.json'), 'utf8')); 
          items.push({ name: manifest.name, version: manifest.version, kind: manifest.kind });
        } catch {
          // Ignore incomplete registry entries.
        }
      }
      items.sort((left, right) => left.name.localeCompare(right.name));
      emit({ ok: true, command: 'package list', implemented: true, items }, json,
        items.map((item) => `${item.name}@${item.version} (${item.kind})`).join('\n'));
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ ok: false, command: 'package list', implemented: false, error: message }, json, `Package registry unavailable: ${message}`);
      return 1;
    }
  }

  if (command === 'monitor') {
    try {
      const { Esp32C3NodeProgrammer } = await import('../../programmers/src/index.js');
      const port = flags.find((arg) => arg.startsWith('--port='))?.slice('--port='.length);
      const baudText = flags.find((arg) => arg.startsWith('--baud='))?.slice('--baud='.length);
      const monitor = await new Esp32C3NodeProgrammer().monitor({
        path: port,
        baudRate: baudText ? Number(baudText) : 115200,
        onLine: (line) => process.stdout.write(`${line}\n`)
      });

      process.once('SIGINT', () => {
        void monitor.close().finally(() => process.exit(0));
      });
      await new Promise(() => {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ ok: false, command: 'monitor', error: message }, json, `Monitor failed: ${message}`);
      return 1;
    }
  }

  if (command === 'upload') {
    try {
      const { Esp32C3NodeProgrammer } = await import('../../programmers/src/index.js');
      const { readFile } = await import('node:fs/promises');
      const project = flags.find((arg) => arg.startsWith('--project='))?.slice('--project='.length) ?? 'examples/esp32-c3-supermini/blink';
      const target = resolve(project);
      const appBin = (await import('node:fs/promises')).readdir(target + '/build').then((names) => names.find((name) => name.endsWith('.bin') && name !== 'bootloader.bin' && name !== 'partition-table.bin'));
      const appName = await appBin;
      if (!appName) throw new Error(`No application binary found in ${target}/build`);

      const files = [
        { address: 0x0, data: await readFile(resolve(target, 'build/bootloader/bootloader.bin')) },
        { address: 0x8000, data: await readFile(resolve(target, 'build/partition_table/partition-table.bin')) },
        { address: 0x10000, data: await readFile(resolve(target, 'build', appName)) }
      ];
      const port = flags.find((arg) => arg.startsWith('--port='))?.slice('--port='.length);
      const result = await new Esp32C3NodeProgrammer().writeFlash(files, { path: port, baudRate: 115200 });
      emit({ command: 'upload', ...result }, json, `Uploaded ${appName} to ${port ?? 'ESP32-C3'}`);
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ ok: false, command: 'upload', error: message }, json, `Upload failed: ${message}`);
      return 1;
    }
  }

  if (command === 'test') {
    const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8'
    });
    if (result.error) {
      emit({ ok: false, command: 'test', error: result.error.message }, json, `Tests failed: ${result.error.message}`);
      return 1;
    }
    if (result.status !== 0) {
      emit({ ok: false, command: 'test', status: result.status, stdout: result.stdout, stderr: result.stderr }, json, result.stderr || result.stdout || 'Tests failed');
      return result.status ?? 1;
    }
    emit({ ok: true, command: 'test', stdout: result.stdout }, json, result.stdout || 'Tests passed');
    return 0;
  }

  const planned = new Set(['install', 'uninstall', 'update']);
  if (planned.has(command)) {
    const message = `The '${command}' command is planned but not implemented yet`;
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, command, implemented: false, error: message })}\n`);
    else process.stderr.write(`${message}\n`);
    return 2;
  }

  const message = `Unknown command: ${command}`;
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message, usage: 'wicro --help' })}\n`);
  else process.stderr.write(`${message}\n\n${help()}`);
  return 64;
}
