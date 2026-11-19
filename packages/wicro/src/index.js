import { createRequire } from 'node:module';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

export const version = packageJson.version;

export const help = () => {
  return `Wicro ${version}\n\nUsage:\n  wicro <command> [options]\n\nCommands:\n  init [name]       Create a Wicro project\n  build             Build firmware with the shared WASM engine\n  rebuild           Rebuild firmware\n  clean             Remove Wicro build and cache directories\n  upload            Upload an ESP32-C3 firmware image\n  monitor           Monitor the ESP32-C3 serial console\n  install           Install packages and transitive dependencies\n  uninstall         Remove installed packages\n  update            Update packages and refresh the lockfile\n  board list        List available boards\n  device list       List detected ESP32-C3 devices\n  package list      List registry packages\n  doctor            Inspect the Node.js host environment\n  test              Run workspace tests\n\nOptions:\n  -h, --help        Show this help message\n  -V, --version     Show the version\n      --json        Emit machine-readable JSON\n`;
};

/** @returns {Promise<string>} */
const findRegistryRoot = async () => {
  const { readdir } = await import('node:fs/promises');
  const candidates = [
    resolve(new URL('../../../registry', import.meta.url).pathname),
    resolve(new URL('../registry', import.meta.url).pathname)
  ];
  for (const candidate of candidates) {
    try {
      await readdir(candidate);
      return candidate;
    } catch {
      // Try the next packaged or repository location.
    }
  }
  throw new Error('Wicro package registry is unavailable');
};

/** @returns {Promise<string>} */
const findLlvmWasm = async () => {
  const { readFile } = await import('node:fs/promises');
  const candidates = [
    resolve(new URL('../toolchain/llvm-wasm/cache/llvm.wasm', import.meta.url).pathname),
    resolve(new URL('../../../toolchain/llvm-wasm/cache/llvm.wasm', import.meta.url).pathname)
  ];
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // Try the repository or prepared-package location.
    }
  }
  throw new Error('Wicro LLVM WASM toolchain is unavailable');
};

/** @param {string} source */
const inferPackageName = (source) => {
  try {
    if (/^https?:\/\//.test(source) || /^file:\/\//.test(source)) {
      const pathname = /^https?:\/\//.test(source) ? new URL(source).pathname : new URL(source).pathname;
      const basename = pathname.split('/').filter(Boolean).pop() ?? 'package';
      return basename.replace(/\.(zip|tgz)$/i, '').replace(/[^a-z0-9._~-]/gi, '-');
    }
  } catch {
    // Fall through to the local path basename.
  }
  const basename = source.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? 'package';
  return basename.replace(/\.(zip|tgz)$/i, '').replace(/[^a-z0-9._~-]/gi, '-');
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
        board: 'arduino-uno-original',
        framework: 'arduino',
        toolchain: 'llvm-wasm-espressif',
        build: {
          sources: ['src/main.ino']
        }
      };
      await writeFile(resolve(target, 'wicro.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: force ? 'w' : 'wx' });
      await writeFile(resolve(target, 'src', 'main.ino'), 'void setup() {\n  pinMode(LED_BUILTIN, OUTPUT);\n}\n\nvoid loop() {\n  digitalWrite(LED_BUILTIN, HIGH);\n  delay(500);\n  digitalWrite(LED_BUILTIN, LOW);\n  delay(500);\n}\n', { flag: 'wx' });

      emit({ ok: true, command: 'init', path: target, manifest: 'wicro.json' }, json, `Initialized Wicro project at ${target}`);
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!json) process.stderr.write(`Wicro init failed: ${message}\n`);
      else process.stderr.write(`${JSON.stringify({ ok: false, command: 'init', error: message })}\n`);
      return 1;
    }
  }

  if (command === 'import') {
    try {
      const source = flags.find((arg) => arg.startsWith('--source='))?.slice('--source='.length)
        ?? flags.slice(1).find((arg) => !arg.startsWith('--'));
      if (!source) throw new Error('A project directory or ZIP source is required');
      const destinationName = flags.find((arg) => arg.startsWith('--dest='))?.slice('--dest='.length)
        ?? inferPackageName(source);
      const target = resolve(destinationName);
      const fs = await import('node:fs/promises');

      if (/^https?:\/\//.test(source)) {
        const response = await fetch(source);
        if (!response.ok) throw new Error(`Project download failed (${response.status}): ${source}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const { unzipSync } = await import('fflate');
        const entries = unzipSync(bytes);
        await fs.mkdir(target, { recursive: true });
        for (const [rawName, data] of Object.entries(entries)) {
          if (rawName.endsWith('/') || rawName.endsWith('\\')) continue;
          const name = rawName.replace(/\\/g, '/').replace(/^\/+/, '');
          if (!name || name.startsWith('/') || name.split('/').includes('..')) throw new Error(`Unsafe project archive path: ${rawName}`);
          const output = resolve(target, name);
          await fs.mkdir(output.slice(0, output.lastIndexOf('/')), { recursive: true });
          await fs.writeFile(output, data);
        }
      } else {
        const details = await fs.stat(resolve(source));
        if (details.isDirectory()) {
          await fs.cp(resolve(source), target, { recursive: true, dereference: true });
        } else {
          const bytes = await fs.readFile(resolve(source));
          const { unzipSync } = await import('fflate');
          const entries = unzipSync(bytes);
          await fs.mkdir(target, { recursive: true });
          for (const [rawName, data] of Object.entries(entries)) {
            if (rawName.endsWith('/') || rawName.endsWith('\\')) continue;
            const name = rawName.replace(/\\/g, '/').replace(/^\/+/, '');
            if (!name || name.startsWith('/') || name.split('/').includes('..')) throw new Error(`Unsafe project archive path: ${rawName}`);
            const output = resolve(target, name);
            await fs.mkdir(output.slice(0, output.lastIndexOf('/')), { recursive: true });
            await fs.writeFile(output, data);
          }
        }
      }

      let framework = 'arduino';
      try {
        await fs.readFile(resolve(target, 'platformio.ini'), 'utf8');
        framework = 'platformio';
      } catch {
        // No platformio.ini means the imported project uses the Arduino workflow.
      }

      const manifest = {
        $schema: 'https://wicro.dev/schemas/project.schema.json',
        name: destinationName,
        board: 'arduino-uno-original',
        framework,
        toolchain: 'llvm-wasm-espressif'
      };
      await fs.writeFile(resolve(target, 'wicro.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: flags.includes('--force') ? 'w' : 'wx' });
      emit({ ok: true, command: 'import', implemented: true, path: target, framework, manifest: 'wicro.json' }, json,
        `Imported ${source} to ${target} (${framework})`);
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ ok: false, command: 'import', implemented: false, error: message }, json, `Import failed: ${message}`);
      return 1;
    }
  }

  if (command === 'build' || command === 'rebuild') {
    const project = flags.find((arg) => arg.startsWith('--project='))?.slice('--project='.length) ?? '.';
    const board = flags.find((arg) => arg.startsWith('--board='))?.slice('--board='.length);
    const target = resolve(project);

    try {
      /** @type {any} */
      let coreModule;
      try {
        coreModule = await import('../../core/src/index.js');
      } catch {
        const vendorSpecifier = '../vendor/core/src/index.js';
        coreModule = await import(vendorSpecifier);
      }
      const { createWicroEngine } = coreModule;
      const { readFile, writeFile } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      const cacheOverride = flags.find((arg) => arg.startsWith('--cache='))?.slice('--cache='.length);
      /** @type {any} */
      let nodeCacheModule;
      /** @type {any} */
      let sdkModule;
      try {
        nodeCacheModule = await import('../../registry/src/node-cache.js');
        sdkModule = await import('../../registry/src/sdk.js');
      } catch {
        const nodeCacheSpecifier = '../vendor/registry/src/node-cache.js';
        const sdkSpecifier = '../vendor/registry/src/sdk.js';
        nodeCacheModule = await import(nodeCacheSpecifier);
        sdkModule = await import(sdkSpecifier);
      }
      const { NodeSdkStorage, defaultWicroCacheDirectory } = nodeCacheModule;
      const { SdkLifecycleManager } = sdkModule;
      const cacheDirectory = defaultWicroCacheDirectory(cacheOverride);
      const sdkStorage = new NodeSdkStorage({ root: cacheDirectory });
      const sdkLifecycle = new SdkLifecycleManager({ storage: sdkStorage });

      try {
        const registryRoot = await findRegistryRoot();
        const manifestValue = await readFile(resolve(target, 'wicro.json'), 'utf8');
        const projectManifest = JSON.parse(manifestValue);
        const boardName = board ?? projectManifest.board;
        if (!boardName) throw new Error('No board target was specified');
        const boardManifest = JSON.parse(await readFile(resolve(registryRoot, boardName, 'package.json'), 'utf8'));
        for (const [frameworkName, range] of Object.entries(/** @type {Record<string,string>} */ (boardManifest.dependencies ?? {}))) {
          if (!frameworkName.startsWith('arduino-') && frameworkName !== 'esp-idf' && frameworkName !== 'pico-sdk' && frameworkName !== 'cmsis') continue;
          try {
            const frameworkManifest = JSON.parse(await readFile(resolve(registryRoot, frameworkName, 'package.json'), 'utf8'));
            if (frameworkManifest.metadata?.distribution?.url) {
              await sdkLifecycle.ensure(frameworkManifest);
            }
          } catch (error) {
            if (error instanceof Error && error.message.includes('no downloadable distribution')) throw error;
            throw error;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit({ ok: false, command, error: `SDK resolution failed: ${message}` }, json, `Build failed: SDK resolution failed: ${message}`);
        return 1;
      }

      /** @type {import('../../core/src/index.js').WicroHostAdapter} */
      const host = {
        host: 'node',
        cacheDirectory,
        readFile: async (/** @type {string} */ path, /** @type {{encoding?:'utf8'|'binary'}|undefined} */ options) => {
          const normalized = path.replace(/\\/g, '/');
          const sdkMatch = normalized.match(/(?:^|\/)registry\/([^/]+)(?:\/(.*))?$/);
          if (sdkMatch?.[1]) {
            const registryRoot = await findRegistryRoot();
            const registryPath = resolve(registryRoot, sdkMatch[1], sdkMatch[2] ?? 'package.json');
            if (options?.encoding === 'utf8') return readFile(registryPath, 'utf8');
            return readFile(registryPath);
          }
          if (options?.encoding === 'utf8') return readFile(resolve(path), 'utf8');
          return readFile(resolve(path));
        },
        readdir: async (/** @type {string} */ path) => {
          const { readdir: readDirectory } = await import('node:fs/promises');
          const normalized = path.replace(/\\/g, '/');
          const registryMatch = normalized.match(/(?:^|\/)registry\/([^/]+)(?:\/([^/].*))?$/);
          if (registryMatch?.[1]) {
            const registryRoot = await findRegistryRoot();
            const absolute = resolve(registryRoot, registryMatch[1], registryMatch[2] ?? '');
            return readDirectory(absolute);
          }
          return readDirectory(resolve(path));
        },
        writeFile: async (/** @type {string} */ path, /** @type {string|Uint8Array} */ data) => {
          const { mkdir } = await import('node:fs/promises');
          const absolute = resolve(path);
          await mkdir(dirname(absolute), { recursive: true });
          await writeFile(absolute, data);
        }
      };
      const llvmPath = await findLlvmWasm();
      const engine = createWicroEngine({ host, llvmPath });
      const result = await engine.execute({ command: 'build', project: target, board });
      if (!result.ok) {
        const message = result.diagnostics?.map((/** @type {{message:string}} */ diagnostic) => diagnostic.message).join('; ') ?? 'Build failed';
        emit({ ok: false, command, error: message }, json, `Build failed: ${message}`);
        return 1;
      }
      const value = result.value && typeof result.value === 'object'
        ? /** @type {Record<string, unknown>} */ (result.value)
        : {};
      emit({ ok: true, command, adapter: 'shared-wasm-engine', ...value }, json, `Built ${board ?? 'configured target'} with the shared WASM engine`);
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ ok: false, command, error: message }, json, `Build failed: ${message}`);
      return 1;
    }
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
      const registryRoot = await findRegistryRoot();
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
      /** @type {any} */
      let hardwareModule;
      try {
        hardwareModule = await import('../../hardware/src/index.js');
      } catch {
        const vendorSpecifier = '../vendor/hardware/src/index.js';
        hardwareModule = await import(vendorSpecifier);
      }
      const { NodeSerialHost } = hardwareModule;
      const items = await new NodeSerialHost().discover();
      emit({ ok: true, command: 'device list', implemented: true, items }, json,
        items.map((/** @type {{path:string,manufacturer?:string}} */ item) => `${item.path}${item.manufacturer ? ` (${item.manufacturer})` : ''}`).join('\n') || 'No serial devices found');
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
      const registryRoot = await findRegistryRoot();
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

  if (command === 'platformio') {
    try {
      const action = flags[1] ?? 'search';
      if (action === 'import') {
        const source = flags.find((arg) => arg.startsWith('--source='))?.slice('--source='.length) ?? 'platformio.ini';
        const { readFile } = await import('node:fs/promises');
        let arduinoModule;
        try {
          arduinoModule = await import('../../arduino/src/index.js');
        } catch {
          const arduinoSpecifier = '../vendor/arduino/src/index.js';
          arduinoModule = await import(arduinoSpecifier);
        }
        const text = await readFile(resolve(source), 'utf8');
        const sections = arduinoModule.parsePlatformIoIni(text);
        emit({ ok: true, command: 'platformio import', implemented: true, sections }, json, `Imported ${Object.keys(sections).length} PlatformIO section(s)`);
        return 0;
      }

      const query = flags.slice(2).find((arg) => !arg.startsWith('--')) ?? '';
      if (!query) throw new Error('A PlatformIO search query is required');
      let registryModule;
      try {
        registryModule = await import('../../registry/src/index.js');
      } catch {
        const registrySpecifier = '../vendor/registry/src/index.js';
        registryModule = await import(registrySpecifier);
      }
      const registry = new registryModule.PlatformIoRegistry();
      const items = await registry.search(query);
      emit({ ok: true, command: 'platformio search', implemented: true, items }, json,
        items.map((/** @type {{name:string,owner:string,version:string}} */ item) => `${item.owner}/${item.name}@${item.version}`).join('\n'));
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ ok: false, command: 'platformio', implemented: false, error: message }, json, `PlatformIO command failed: ${message}`);
      return 1;
    }
  }

  if (command === 'arduino') {
    try {
      const action = flags[1];
      let arduinoModule;
      try {
        arduinoModule = await import('../../arduino/src/index.js');
      } catch {
        const arduinoSpecifier = '../vendor/arduino/src/index.js';
        arduinoModule = await import(arduinoSpecifier);
      }
      const registry = new arduinoModule.ArduinoRegistry({ host: 'node' });

      if (action === 'library' && flags[2] === 'search') {
        const query = flags.slice(3).find((arg) => !arg.startsWith('--')) ?? '';
        const items = await registry.searchLibraries(query);
        emit({ ok: true, command: 'arduino library search', implemented: true, items }, json,
          items.map((/** @type {{name:string,version:string}} */ item) => `${item.name}@${item.version}`).join('\n'));
        return 0;
      }

      if (action === 'boards') {
        const index = await registry.boardIndex();
        const packages = Array.isArray(index?.packages) ? index.packages : [];
        emit({ ok: true, command: 'arduino boards', implemented: true, count: packages.length }, json,
          `Loaded ${packages.length} Arduino Board Manager package(s)`);
        return 0;
      }

      throw new Error(`Unknown Arduino command: ${action ?? 'missing'}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ ok: false, command: 'arduino', implemented: false, error: message }, json, `Arduino command failed: ${message}`);
      return 1;
    }
  }

  if (command === 'monitor') {
    try {
      /** @type {any} */
      let programmerModule;
      try {
        programmerModule = await import('../../programmers/src/index.js');
      } catch {
        const vendorSpecifier = '../vendor/programmers/src/index.js';
        programmerModule = await import(vendorSpecifier);
      }
      const { Esp32C3NodeProgrammer } = programmerModule;
      const port = flags.find((arg) => arg.startsWith('--port='))?.slice('--port='.length);
      const baudText = flags.find((arg) => arg.startsWith('--baud='))?.slice('--baud='.length);
      const monitor = await new Esp32C3NodeProgrammer().monitor({
        path: port,
        baudRate: baudText ? Number(baudText) : 115200,
        onLine: (/** @type {string} */ line) => process.stdout.write(`${line}\n`)
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
      /** @type {any} */
      let programmerModule;
      try {
        programmerModule = await import('../../programmers/src/index.js');
      } catch {
        const vendorSpecifier = '../vendor/programmers/src/index.js';
        programmerModule = await import(vendorSpecifier);
      }
      const { Esp32C3NodeProgrammer } = programmerModule;
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

  if (command === 'install' || command === 'uninstall' || command === 'update') {
    try {
      const { readdir, readFile, writeFile, mkdir } = await import('node:fs/promises');
      /** @type {any} */
      let registryModule;
      /** @type {any} */
      let installerModule;
      try {
        registryModule = await import('../../registry/src/index.js');
        installerModule = await import('../../registry/src/installer.js');
      } catch {
        const registrySpecifier = '../vendor/registry/src/index.js';
        const installerSpecifier = '../vendor/registry/src/installer.js';
        registryModule = await import(registrySpecifier);
        installerModule = await import(installerSpecifier);
      }
      const { PackageRegistry } = registryModule;
      const { PackageInstaller } = installerModule;
      const registry = new PackageRegistry();
      const registryRoot = await findRegistryRoot();

      for (const name of await readdir(registryRoot)) {
        try {
          const manifest = JSON.parse(await readFile(resolve(registryRoot, name, 'package.json'), 'utf8'));
          await registry.add(manifest);
        } catch {
          // Ignore registry entries that are incomplete or not package manifests.
        }
      }

      const nameFlag = flags.find((arg) => arg.startsWith('--name='))?.slice('--name='.length);
      const shaFlag = flags.find((arg) => arg.startsWith('--sha256='))?.slice('--sha256='.length);
      const cacheFlag = flags.find((arg) => arg.startsWith('--cache='))?.slice('--cache='.length);
      const sourceFlag = flags.find((arg) => arg.startsWith('--source='))?.slice('--source='.length);
      const packageName = sourceFlag ?? nameFlag ?? flags.slice(1).find((arg) => !arg.startsWith('--'));
      const cacheDirectory = resolve(cacheFlag ?? '.wicro/cache/packages');

      await mkdir(resolve('.wicro'), { recursive: true });
      await mkdir(cacheDirectory, { recursive: true });

      if (command === 'uninstall') {
        if (!packageName) throw new Error('A package name is required');
        const installer = new PackageInstaller();
        const removed = await installer.remove(packageName);
        emit({ command, implemented: true, ...removed }, json, `Removed ${packageName}`);
        return 0;
      }

      if (!packageName) throw new Error('A package name or source is required');
      const installer = new PackageInstaller();
      const installed = [];

      if (/^https?:\/\//.test(packageName) || /^file:\/\//.test(packageName) || /(^|\/)[^/]+\.(zip|tgz)$/.test(packageName)) {
        const name = nameFlag ?? inferPackageName(packageName);
        const result = await installer.install(packageName, {
          name,
          sha256: shaFlag,
          cacheDirectory
        });
        await mkdir(resolve('.wicro/packages'), { recursive: true });
        const packageTarget = resolve('.wicro/packages', name);
        const fsPromises = await import('node:fs/promises');
        await fsPromises.rm(packageTarget, { recursive: true, force: true });
        const cachedSource = resolve(cacheDirectory, name);
        await fsPromises.cp(cachedSource, packageTarget, { recursive: true, dereference: true });
        installed.push({ name, version: 'custom', source: packageName, kind: result.kind });
      } else {
        const manifests = registry.resolveTree(packageName);
        for (const manifest of manifests) {
          const sourceDirectory = resolve(registryRoot, manifest.name);
          const result = await installer.installLocal(sourceDirectory, {
            name: manifest.name,
            cacheDirectory
          });
          await mkdir(resolve('.wicro/packages', manifest.name), { recursive: true });
          const packageTarget = resolve('.wicro/packages', manifest.name);
          await (await import('node:fs/promises')).cp(sourceDirectory, packageTarget, { recursive: true, dereference: true });
          installed.push({ name: manifest.name, version: manifest.version, source: sourceDirectory, kind: result.kind });
        }
      }

      const lock = {
        lockfileVersion: 1,
        packages: Object.fromEntries(installed.map((item) => [item.name, { version: item.version, source: item.source }]))
      };
      await writeFile(resolve('.wicro/wicro-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);

      emit({ ok: true, command, implemented: true, count: installed.length, packages: installed, lockfile: '.wicro/wicro-lock.json' }, json,
        `${command === 'update' ? 'Updated' : 'Installed'} ${installed.length} package${installed.length === 1 ? '' : 's'}${command === 'update' ? '' : ''}`);
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ ok: false, command, implemented: false, error: message }, json, `${command} failed: ${message}`);
      return 1;
    }
  }

  const message = `Unknown command: ${command}`;
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message, usage: 'wicro --help' })}\n`);
  else process.stderr.write(`${message}\n\n${help()}`);
  return 64;
}
