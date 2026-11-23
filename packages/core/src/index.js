import { LlvmWasmToolchain, extractArchiveMember, patchElfSectionFlags, validateEsp32Image } from '../../runtime/src/index.js';
import { preprocessIno } from '../../arduino/src/index.js';

/**
 * Versioned, deterministic ESP32-C3 Arduino-ESP32 WASM firmware build recipe.
 * Uses file-backed `/sdk` WASI preopens so SDK archives remain on disk.
 */
export const ESP32_C3_ARDUINO_RECIPE = Object.freeze({
  version: 'esp32-c3-arduino-wasm-v1',
  target: 'riscv32',
  targetOptions: Object.freeze({ march: 'rv32imc_zicsr_zifencei', mabi: 'ilp32' }),
  compilerFlags: Object.freeze([
    '-std=gnu++11',
    '-Os',
    '-ffunction-sections',
    '-fdata-sections',
    '-fno-rtti',
    '-fno-exceptions',
    '-fno-builtin',
    '-Wno-invalid-constexpr',
    '-Wno-section',
    '-Wno-ignored-attributes',
    '-Wno-unknown-attributes',
    '-Wno-deprecated-builtins',
    '-Wno-keyword-compat',
    '-Wno-extern-c-compat'
  ]),
  defines: Object.freeze([
    'F_CPU=160000000L',
    'ARDUINO=10812',
    'ARDUINO_ESP32C3_DEV',
    'ARDUINO_ARCH_ESP32',
    'ESP32=ESP32',
    'CORE_DEBUG_LEVEL=0',
    'ARDUINO_USB_MODE=1',
    'ARDUINO_USB_CDC_ON_BOOT=1',
    'ARDUINO_RUNNING_CORE=0',
    'ARDUINO_EVENT_RUNNING_CORE=0'
  ]),
  includeDirs: Object.freeze([
    '/sdk/sysroot/include', '/sdk/sysroot/gcc', '/sdk/sysroot/include-cpp/15.2.0',
    '/sdk/core', '/sdk/variant', '/sdk/include', '/sdk/include/config',
    '/sdk/include/freertos/include', '/sdk/include/freertos/include/esp_additions/freertos',
    '/sdk/include/freertos/include/esp_additions', '/sdk/include/freertos/port/riscv/include',
    '/sdk/include/driver/include', '/sdk/include/driver/esp32c3/include',
    '/sdk/include/esp_common/include',
    '/sdk/include/esp_rom/include', '/sdk/include/esp_rom/esp32c3', '/sdk/include/esp_rom/include/esp32c3',
    '/sdk/include/esp_hw_support/include', '/sdk/include/esp_hw_support/include/soc',
    '/sdk/include/esp_hw_support/include/soc/esp32c3',
    '/sdk/include/riscv/include', '/sdk/include/esp_timer/include', '/sdk/include/heap/include',
    '/sdk/include/esp_system/include', '/sdk/include/esp_event/include',
    '/sdk/include/esp_wifi/include', '/sdk/include/esp_netif/include', '/sdk/include/esp_eth/include',
    '/sdk/include/tcpip_adapter/include',
    '/sdk/include/lwip/include', '/sdk/include/lwip/include/apps', '/sdk/include/lwip/include/apps/sntp',
    '/sdk/include/lwip/lwip/src/include', '/sdk/include/lwip/port/esp32/include',
    '/sdk/include/lwip/port/esp32/include/arch',
    '/sdk/include/spi_flash/include', '/sdk/include/app_update/include',
    '/sdk/include/bootloader_support/include', '/sdk/include/efuse/include', '/sdk/include/efuse/esp32c3/include',
    '/sdk/include/esp_pm/include', '/sdk/include/esp_ipc/include',
    '/sdk/include/mbedtls/mbedtls/include', '/sdk/include/mbedtls/port/include',
    '/sdk/include/log/include', '/sdk/include/esp_ringbuf/include',
    '/sdk/include/soc/include', '/sdk/include/soc/esp32c3/include',
    '/sdk/include/hal/include', '/sdk/include/hal/esp32c3/include',
    '/sdk/include/newlib/platform_include', '/sdk/include/vfs/include'
  ]),
  coreSources: Object.freeze(['core/HWCDC.cpp', 'core/HardwareSerial.cpp']),
  libArchives: Object.freeze([
    'libFrameworkArduino.a', 'libspi_flash.a', 'libesp_system.a', 'libfreertos.a', 'libdriver.a',
    'libesp_hw_support.a', 'libesp_rom.a', 'libesp_common.a', 'libesp_timer.a',
    'libhal.a', 'libsoc.a', 'libheap.a', 'liblog.a', 'libnewlib.a', 'libvfs.a',
    'libpthread.a', 'libcxx.a', 'libriscv.a', 'libefuse.a', 'libesp_pm.a',
    'libesp_ipc.a', 'libesp_event.a', 'libesp_ringbuf.a', 'libapp_update.a',
    'libbootloader_support.a', 'libnvs_flash.a', 'libesp_phy.a', 'libbt.a',
    'libespcoredump.a', 'libcoexist.a', 'libesp_wifi.a', 'libesp_netif.a',
    'liblwip.a', 'libwpa_supplicant.a', 'libmbedcrypto.a', 'libesp_gdbstub.a',
    'libstdc++.a', 'libsupc++.a', 'libc.a', 'libm.a', 'libnosys.a', 'libgcc.a'
  ]),
  ldArchives: Object.freeze(['libphy.a', 'libbtdm_app.a', 'libbtbb.a']),
  romLinkerScripts: Object.freeze([
    'esp32c3.rom.ld',
    'esp32c3.rom.api.ld',
    'esp32c3.rom.libgcc.ld',
    'esp32c3.rom.newlib.ld',
    'esp32c3.rom.version.ld',
    'esp32c3.rom.newlib-time.ld',
    'esp32c3.rom.eco3.ld',
    'esp32c3.peripherals.ld'
  ]),
  undefinedSymbols: Object.freeze([
    '_Z5setupv', '_Z4loopv', 'esp_app_desc',
    'pthread_include_pthread_impl', 'pthread_include_pthread_cond_var_impl',
    'pthread_include_pthread_local_storage_impl', 'pthread_include_pthread_rwlock_impl',
    'include_esp_phy_override', 'start_app', '__ubsan_include', '__assert_func',
    'vfs_include_syscalls_impl', 'app_main',
    'newlib_include_heap_impl', 'newlib_include_syscalls_impl',
    'newlib_include_pthread_impl', 'newlib_include_assert_impl',
    '__cxa_guard_dummy', 'uxTopUsedPriority'
  ]),
  extraLinkerArgs: Object.freeze(['-z', 'norelro']),
  image: Object.freeze({ flashMode: 'dio', flashFreq: '80m', flashSize: '4MB', appOffset: 0x10000, chipId: 5 })
});

/**
 * Adapt upstream ESP-IDF memory.ld and sections.ld for LLD's pass-1 symbol
 * evaluation and section garbage collection while preserving exact memory regions,
 * section addresses, and all upstream assertions.
 * @param {string} rawMemoryLd
 * @param {string} rawSectionsLd
 * @returns {{memoryLd:string,sectionsLd:string}}
 */
export const prepareEsp32C3LinkerScripts = (rawMemoryLd, rawSectionsLd) => {
  const assertIndex = rawMemoryLd.indexOf('  ASSERT(_flash_rodata_dummy_start');
  const memoryLd = assertIndex >= 0 ? rawMemoryLd.slice(0, assertIndex) : rawMemoryLd;

  let sectionsLd = rawSectionsLd;
  const iramEndStart = sectionsLd.indexOf('  .iram0.text_end (NOLOAD) :');
  const heapStart = sectionsLd.indexOf('  /* Marks the end of data, bss');
  const dramDummyStart = sectionsLd.indexOf('  /**\n   * This section is required to skip .iram0.text');
  if (iramEndStart >= 0 && heapStart > iramEndStart && dramDummyStart >= 0 && dramDummyStart < iramEndStart) {
    const iramTailBlock = sectionsLd.slice(iramEndStart, heapStart);
    sectionsLd = sectionsLd.slice(0, iramEndStart) + sectionsLd.slice(heapStart);
    const updatedDramDummyStart = sectionsLd.indexOf('  /**\n   * This section is required to skip .iram0.text');
    sectionsLd = sectionsLd.slice(0, updatedDramDummyStart) + iramTailBlock + '\n' + sectionsLd.slice(updatedDramDummyStart);
  }

  sectionsLd = sectionsLd
    .replace('KEEP (*(.eh_frame))', '')
    .replace('KEEP (*(.eh_frame_hdr))', '');

  const heapIdx = sectionsLd.lastIndexOf('  .dram0.heap_start');
  if (heapIdx >= 0) {
    sectionsLd = sectionsLd.slice(0, heapIdx)
      + '  /DISCARD/ : { *(.eh_frame) *(.eh_frame_hdr) }\n'
      + sectionsLd.slice(heapIdx);
  }
  if (assertIndex >= 0) {
    sectionsLd += '\nASSERT(_flash_rodata_dummy_start == ORIGIN(default_rodata_seg), ".flash_rodata_dummy section must be placed at the beginning of the rodata segment.")\n';
  }
  return { memoryLd, sectionsLd };
};

/** @typedef {'browser'|'node'|'vscode'} WicroHost */

/**
 * @typedef {object} WicroDiagnostic
 * @property {'error'|'warning'|'info'} severity
 * @property {string} message
 * @property {string} [source]
 * @property {string} [file]
 * @property {number} [line]
 * @property {number} [column]
 */

/**
 * @typedef {object} WicroResult
 * @property {boolean} ok
 * @property {unknown} [value]
 * @property {WicroDiagnostic[]} [diagnostics]
 */

/**
 * @typedef {object} WicroHostAdapter
 * @property {WicroHost} host
 * @property {(path: string, options?: {encoding?: 'utf8'|'binary'}) => Promise<string|Uint8Array>} readFile
 * @property {(path: string) => Promise<string[]>} [readdir]
 * @property {string} [cacheDirectory]
 * @property {string} [sdkCacheDirectory]
 * @property {(path: string, data: string|Uint8Array) => Promise<void>} writeFile
 */

/**
 * @typedef {object} WicroEngineOptions
 * @property {WicroHostAdapter} host
 * @property {import('../../registry/src/index.js').PackageRegistry} [registry]
 * @property {LlvmWasmToolchain} [toolchain]
 * @property {string} [llvmPath]
 * @property {() => Promise<{llvmPath:string,linkerPath?:string}>} [resolveToolchain]
 */

/**
 * Creates a host-independent Wicro engine.
 * @param {WicroEngineOptions} options
 */
export const createWicroEngine = (options) => {
  if (!options.host) throw new Error('A host adapter is required');

  let toolchain = options.toolchain;
  /** @returns {Promise<LlvmWasmToolchain>} */
  const ensureToolchain = async () => {
    if (toolchain) return toolchain;
    if (options.resolveToolchain) {
      const resolved = await options.resolveToolchain();
      toolchain = new LlvmWasmToolchain({ llvmPath: resolved.llvmPath, linkerPath: resolved.linkerPath });
      return toolchain;
    }
    if (options.llvmPath) {
      toolchain = new LlvmWasmToolchain({ llvmPath: options.llvmPath });
      return toolchain;
    }
    throw new Error('LLVM WASM toolchain asset is not installed. Configure an external compiler distribution or local source and retry.');
  };

  return Object.freeze({
    host: options.host.host,

    /**
     * Execute a host-independent command.
     * @param {string|{command:'build',project:string,board?:string}|{command:'compile',source:string,board:string}|{command:'targets'}} command
     * @returns {Promise<WicroResult>}
     */
    async execute(command) {
      const resolvedToolchain = await ensureToolchain();
      toolchain = resolvedToolchain;
      if (typeof command === 'string') {
        if (command === 'targets') {
          try {
            const targets = await toolchain.targets();
            return { ok: true, value: targets };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, diagnostics: [{ severity: 'error', message }] };
          }
        }
        if (command.trim().length === 0) {
          return {
            ok: false,
            diagnostics: [{ severity: 'error', message: 'A command name is required' }]
          };
        }
        return {
          ok: false,
          diagnostics: [{ severity: 'info', message: `Command '${command}' is not implemented yet` }]
        };
      }

      if (command.command === 'targets') {
        return this.execute('targets');
      }

      if (command.command === 'compile') {
        const board = await loadBoardManifest(options.host, command.board);
        const build = asBuildManifest(board.metadata?.build);
        if (!build) {
          return { ok: false, diagnostics: [{ severity: 'error', message: `Board '${command.board}' has no compilation recipe` }] };
        }
        try {
          const result = await toolchain.compileC(command.source, build.target, build.targetOptions);
          return { ok: true, value: result, diagnostics: result.diagnostics.map((/** @type {string} */ message) => ({ severity: /** @type {'warning'} */ ('warning'), message })) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, diagnostics: [{ severity: 'error', message }] };
        }
      }

      if (command.command === 'build') {
        try {
          const result = await buildProject(options.host, toolchain, command.project, command.board);
          return { ok: true, value: result, diagnostics: result.diagnostics.map((/** @type {string} */ message) => ({ severity: /** @type {'warning'} */ ('warning'), message })) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, diagnostics: [{ severity: 'error', message }] };
        }
      }

      return { ok: false, diagnostics: [{ severity: 'error', message: 'Unsupported Wicro command' }] };
    }
  });
};

/**
 * @param {WicroHostAdapter} host
 * @param {string} boardName
 * @returns {Promise<import('../../registry/src/index.js').WicroPackageManifest>}
 */
const loadBoardManifest = async (host, boardName) => {
  const candidates = [
    `registry/${boardName}/package.json`,
    `../../../registry/${boardName}/package.json`,
    `../../registry/${boardName}/package.json`
  ];

  let lastError;
  for (const candidate of candidates) {
    try {
      const value = await host.readFile(candidate, { encoding: 'utf8' });
      if (typeof value === 'string') return /** @type {import('../../registry/src/index.js').WicroPackageManifest} */ (JSON.parse(value));
    } catch (error) {
      lastError = error;
    }
  }

  if (host.readdir) {
    try {
      const registryRoots = ['registry', '../../../registry', '../../registry'];
      for (const registryRoot of registryRoots) {
        const names = await host.readdir(registryRoot);
        for (const name of names.sort()) {
          try {
            const value = await host.readFile(`${registryRoot}/${name}/package.json`, { encoding: 'utf8' });
            if (typeof value === 'string') {
              const manifest = /** @type {import('../../registry/src/index.js').WicroPackageManifest} */ (JSON.parse(value));
              if (manifest.name === boardName) return manifest;
            }
          } catch {
            // Continue searching for a matching manifest name.
          }
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error : lastError;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Board package not found: ${boardName}`);
};

/**
 * @param {WicroHostAdapter} host
 * @param {import('../../registry/src/index.js').WicroPackageManifest} boardManifest
 */
const loadSdkFiles = async (host, boardManifest) => {
  /** @type {Record<string,string|Uint8Array>} */
  const files = {};
  /** @type {string[]} */
  const includeDirs = [];
  /** @type {Record<string,Uint8Array>} */
  const archives = {};
  /** @type {Record<string,string>} */
  const linkerScripts = {};
  const readdir = host.readdir;

  /** @param {string} directory @param {string} relative */
  const walk = async (directory, relative) => {
    if (!readdir) return;
    let names;
    try {
      names = await readdir(directory);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const absolute = `${directory}/${name}`.replace(/\/+/g, '/');
      const relativePath = `${relative}/${name}`.replace(/^\//, '').replace(/\/+/g, '/');
      if (/\.a$/i.test(name)) {
        try {
          const binary = await host.readFile(absolute, { encoding: 'binary' });
          if (binary instanceof Uint8Array) archives[`sdk/lib/${name}`] = binary;
        } catch {
          // Archive remains missing and the firmware linker fails closed.
        }
        continue;
      }
      if (!/\.(h|hpp|inc|ld|lds)$/i.test(name)) continue;
      try {
        const value = await host.readFile(absolute, { encoding: 'utf8' });
        if (typeof value === 'string') {
          const normalized = relativePath;
          const virtualPath = `sdk/${normalized}`.replace(/\/+/g, '/');
          files[virtualPath] = value;
          if (/\.(h|hpp|inc)$/i.test(name)) {
            includeDirs.push(virtualPath.slice(0, virtualPath.lastIndexOf('/')));
          }
          if (/\.(ld|lds)$/i.test(name)) {
            linkerScripts[`sdk/${name}`] = value;
          }
        }
      } catch {
        includeDirs.push(`sdk/${relativePath}`.replace(/\/+/g, '/'));
        await walk(absolute, relativePath);
      }
    }
  };

  for (const frameworkName of Object.keys(boardManifest.dependencies ?? {})) {
    let frameworkManifest;
    try {
      frameworkManifest = await loadBoardManifest(host, frameworkName);
    } catch {
      continue;
    }
    if (!host.cacheDirectory || !host.readdir) continue;

    const cacheRoot = `${host.cacheDirectory}/${frameworkName}-${frameworkManifest.version}`;
    /** @param {string} directory @param {string} relative */
    const frameworkWalk = async (directory, relative) => {
      if (!readdir) return;
      let names;
      try {
        names = await readdir(directory);
      } catch {
        return;
      }
      for (const name of names.sort()) {
        const absolute = `${directory}/${name}`.replace(/\/+/g, '/');
        const relativePath = `${relative}/${name}`.replace(/^\//, '').replace(/\/+/g, '/');
        if (/\.a$/i.test(name)) {
          try {
            const binary = await host.readFile(absolute, { encoding: 'binary' });
            if (binary instanceof Uint8Array) archives[`sdk/lib/${name}`] = binary;
          } catch {
            // The archive will remain missing and the firmware linker will fail closed.
          }
          continue;
        }
        if (!/\.(h|hpp|inc|ld|lds)$/i.test(name)) continue;
        try {
          const value = await host.readFile(absolute, { encoding: 'utf8' });
          if (typeof value === 'string') {
            const normalized = relativePath;
            const virtualPath = `sdk/${normalized}`.replace(/\/+/g, '/');
            files[virtualPath] = value;
            if (/\.(h|hpp|inc)$/i.test(name)) {
              includeDirs.push(virtualPath.slice(0, virtualPath.lastIndexOf('/')));
            }
            if (/\/Arduino\.h$|^sdk\/Arduino\.h$/i.test(virtualPath)) {
              includeDirs.push(virtualPath.slice(0, virtualPath.lastIndexOf('/')));
            }
            if (/\/pins_arduino\.h$/i.test(virtualPath)) {
              includeDirs.push(virtualPath.slice(0, virtualPath.lastIndexOf('/')));
            }
            if (/\.(ld|lds)$/i.test(name)) {
              linkerScripts[`sdk/${name}`] = value;
            }
          }
        } catch {
          includeDirs.push(`sdk/${relativePath}`.replace(/\/+/g, '/'));
          await walk(absolute, relativePath);
        }
      }
    };

    await frameworkWalk(cacheRoot, '');
  }

  if (host.sdkCacheDirectory) {
    await walk(host.sdkCacheDirectory, '');
  }

  return { files, includeDirs: [...new Set(includeDirs)], archives, linkerScripts };
};

/**
 * @typedef {object} BuildManifest
 * @property {'object'|'bare-metal'|'firmware'} kind
 * @property {string} target
 * @property {{march?:string,mabi?:string,mcpu?:string,mcu?:string}} [targetOptions]
 * @property {string} [source]
 * @property {string} [startupSource]
 * @property {string} [linkerScript]
 * @property {string} [output]
 */

/** @param {unknown} value @returns {BuildManifest|undefined} */
const asBuildManifest = (value) => {
  if (!value || typeof value !== 'object') return undefined;
  const build = /** @type {Record<string, unknown>} */ (value);
  if (typeof build.target !== 'string') return undefined;
  if (build.kind !== 'object' && build.kind !== 'bare-metal' && build.kind !== 'firmware') return undefined;

  const targetOptionsValue = build.targetOptions;
  const targetOptions = targetOptionsValue && typeof targetOptionsValue === 'object'
    ? /** @type {{march?:string,mabi?:string,mcpu?:string,mcu?:string}} */ (targetOptionsValue)
    : undefined;

  return /** @type {BuildManifest} */ ({
    kind: build.kind,
    target: build.target,
    targetOptions,
    source: typeof build.source === 'string' ? build.source : undefined,
    startupSource: typeof build.startupSource === 'string' ? build.startupSource : undefined,
    linkerScript: typeof build.linkerScript === 'string' ? build.linkerScript : undefined,
    output: typeof build.output === 'string' ? build.output : undefined
  });
};

/**
 * @param {WicroHostAdapter} host
 * @param {LlvmWasmToolchain} toolchain
 * @param {string} project
 * @param {string} [boardName]
 */
const sourceExtension = /\.(ino|pde|cpp|cxx|cc|c|s|S|asm)$/;

/** @param {WicroHostAdapter} host @param {string} directory @param {Set<string>} [visited] */
const discoverSourceFiles = async (host, directory, visited = new Set()) => {
  if (!host.readdir) return [];
  if (visited.has(directory)) return [];
  visited.add(directory);

  /** @type {string[]} */
  const sources = [];
  let names;
  try {
    names = await host.readdir(directory);
  } catch {
    return [];
  }

  for (const name of names.sort()) {
    const path = `${directory}/${name}`.replace(/\/+/g, '/');
    try {
      const value = await host.readFile(path, { encoding: 'utf8' });
      if (typeof value === 'string' && sourceExtension.test(name)) sources.push(path);
    } catch {
      sources.push(...await discoverSourceFiles(host, path, visited));
    }
  }
  return sources;
};

/** @param {string} path */
const normalizeProjectSourcePath = (path) => {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`Unsafe project source path: ${path}`);
  }
  return normalized;
};

/** @param {WicroHostAdapter} host @param {LlvmWasmToolchain} toolchain @param {string} project @param {string} [boardName] */
const buildProject = async (host, toolchain, project, boardName) => {
  let board = boardName;
  /** @type {{board?:string,build?:{sources?:string[],sourceDir?:string,flags?:string[],defines?:string[]},sources?:string[],sourceDir?:string}}} */
  let projectManifest = {};
  try {
    const manifestValue = await host.readFile(`${project}/wicro.json`, { encoding: 'utf8' });
    if (typeof manifestValue === 'string') projectManifest = JSON.parse(manifestValue);
  } catch {
    // Board must be supplied explicitly or resolved from the project manifest.
  }
  if (!board) board = projectManifest.board;
  if (!board) throw new Error('No board target was specified');

  const boardManifest = await loadBoardManifest(host, board);
  const build = asBuildManifest(boardManifest.metadata?.build);
  if (!build) throw new Error(`Board '${board}' has no compilation recipe`);
  if (build.kind === 'firmware' && !toolchain.linkEsp32Elf) {
    throw new Error(`Board '${board}' firmware linking requires a WASM-native ESP32 ELF linker`);
  }

  const sdk = await loadSdkFiles(host, boardManifest);
  const isEsp32C3Firmware = build.kind === 'firmware' && build.target === 'riscv32';

  /** @type {string|undefined} */
  let rawEsp32MemoryLd = sdk.linkerScripts['sdk/memory.ld'];
  /** @type {string|undefined} */
  let rawEsp32SectionsLd = sdk.linkerScripts['sdk/sections.ld'];
  let hasEsp32FrameworkArchive = Boolean(sdk.archives['sdk/lib/libFrameworkArduino.a']);
  /** @type {Uint8Array|undefined} */
  let esp32VectorsObj;
  let hasFullStagedEsp32Sdk = false;

  if (isEsp32C3Firmware && host.sdkCacheDirectory) {
    const sdkRoot = host.sdkCacheDirectory.replace(/\/+$/, '');
    if (!hasEsp32FrameworkArchive) {
      try {
        const probe = await host.readFile(`${sdkRoot}/lib/libFrameworkArduino.a`, { encoding: 'binary' });
        if (probe instanceof Uint8Array && probe.length > 0) hasEsp32FrameworkArchive = true;
      } catch {
        // Firmware linker will fail closed below.
      }
    }
    if (!rawEsp32MemoryLd) {
      for (const candidate of [`${sdkRoot}/ld/memory.ld`, `${sdkRoot}/memory.ld`]) {
        try {
          const text = await host.readFile(candidate, { encoding: 'utf8' });
          if (typeof text === 'string') { rawEsp32MemoryLd = text; break; }
        } catch {
          // Try next candidate.
        }
      }
    }
    if (!rawEsp32SectionsLd) {
      for (const candidate of [`${sdkRoot}/ld/sections.ld`, `${sdkRoot}/sections.ld`]) {
        try {
          const text = await host.readFile(candidate, { encoding: 'utf8' });
          if (typeof text === 'string') { rawEsp32SectionsLd = text; break; }
        } catch {
          // Try next candidate.
        }
      }
    }
    try {
      const libriscv = await host.readFile(`${sdkRoot}/lib/libriscv.a`, { encoding: 'binary' });
      if (libriscv instanceof Uint8Array && libriscv.length > 8) {
        esp32VectorsObj = patchElfSectionFlags(extractArchiveMember(libriscv, 'vectors.S.obj'), '.exception_vectors.text', 0x6);
        hasFullStagedEsp32Sdk = true;
      }
    } catch {
      // Minimal mock SDKs without libriscv.a fall through cleanly for unit tests.
    }
  }

  const boardMetadata = /** @type {{clockHz?:number}} */ (boardManifest.metadata ?? {});
  const boardDefine = board.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
  const defines = isEsp32C3Firmware
    ? [...ESP32_C3_ARDUINO_RECIPE.defines, ...(projectManifest.build?.defines ?? [])]
    : [
        `F_CPU=${typeof boardMetadata.clockHz === 'number' ? boardMetadata.clockHz : 16000000}L`,
        'ARDUINO=10808',
        `ARDUINO_${boardDefine}`,
        `ARDUINO_ARCH_${String(boardManifest.metadata?.architecture ?? '').replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`
      ].filter((value) => !value.endsWith('_'));

  const explicitSources = projectManifest.build?.sources ?? projectManifest.sources;
  /** @type {string[]} */
  let sourcePaths;
  if (explicitSources?.length) {
    sourcePaths = explicitSources.map(normalizeProjectSourcePath);
  } else {
    const sourceDir = projectManifest.build?.sourceDir ?? projectManifest.sourceDir;
    if (sourceDir) {
      sourcePaths = await discoverSourceFiles(host, `${project}/${normalizeProjectSourcePath(sourceDir)}`);
      sourcePaths = sourcePaths.map((path) => normalizeProjectSourcePath(path.slice(project.length + 1)));
    } else {
      sourcePaths = await discoverSourceFiles(host, `${project}/src`);
      sourcePaths = sourcePaths.map((path) => normalizeProjectSourcePath(path.slice(project.length + 1)));
      if (sourcePaths.length === 0) {
        const fallback = await discoverSourceFiles(host, project);
        sourcePaths = fallback
          .map((path) => normalizeProjectSourcePath(path.slice(project.length + 1)))
          .filter((path) => !path.startsWith('.wicro/'));
      }
    }
  }

  if (sourcePaths.length === 0 && build.source) {
    sourcePaths = [normalizeProjectSourcePath(build.source)];
  }
  if (sourcePaths.length === 0) throw new Error(`No source files found for project '${project}'`);

  /** @type {Record<string,string>} */
  const sourceFiles = {};
  for (const sourcePath of sourcePaths) {
    const sourceValue = await host.readFile(`${project}/${sourcePath}`, { encoding: 'utf8' });
    if (typeof sourceValue !== 'string') throw new Error(`Source file is not text: ${sourcePath}`);
    sourceFiles[sourcePath] = sourceValue;
  }

  const inoPaths = sourcePaths
    .filter((path) => /\.(ino|pde)$/i.test(path))
    .sort((left, right) => {
      const leftMain = /(?:^|\/)(?:main|sketch)\.(?:ino|pde)$/i.test(left);
      const rightMain = /(?:^|\/)(?:main|sketch)\.(?:ino|pde)$/i.test(right);
      if (leftMain !== rightMain) return leftMain ? -1 : 1;
      const leftBase = left.split('/').pop() ?? left;
      const rightBase = right.split('/').pop() ?? right;
      if (leftBase.length !== rightBase.length) return leftBase.length - rightBase.length;
      return leftBase.localeCompare(rightBase);
    });

  let result;
  let generatedCpp;
  let sourceMap;
  const riscvEsp32CompilerFlags = build.target === 'riscv32'
    ? [...ESP32_C3_ARDUINO_RECIPE.compilerFlags, ...(projectManifest.build?.flags ?? [])]
    : [];
  const riscvEsp32IncludeDirs = build.target === 'riscv32'
    ? [...ESP32_C3_ARDUINO_RECIPE.includeDirs]
    : [];
  const riscvEsp32Preopens = build.target === 'riscv32' && host.sdkCacheDirectory
    ? { '/sdk': host.sdkCacheDirectory }
    : undefined;
  /** @type {{path:string,object:Uint8Array,cache:string,diagnostics:string[]}[]} */
  const compiledObjects = [];

  /**
   * Link compiled objects into an ESP32-C3 ELF and validate the resulting BIN.
   * @param {Record<string,Uint8Array>} objects
   */
  const linkEsp32C3Firmware = async (objects) => {
    if (!hasEsp32FrameworkArchive) {
      throw new Error(`ESP32-C3 firmware linking is missing sdk/lib/libFrameworkArduino.a in the staged target SDK`);
    }
    if (!rawEsp32MemoryLd || !rawEsp32SectionsLd) {
      throw new Error(`ESP32-C3 firmware linking is missing memory.ld or sections.ld in the staged target SDK`);
    }
    const { memoryLd, sectionsLd } = prepareEsp32C3LinkerScripts(rawEsp32MemoryLd, rawEsp32SectionsLd);

    const linkResult = hasFullStagedEsp32Sdk
      ? await toolchain.linkEsp32Elf({
          preObjects: esp32VectorsObj ? { 'vectors.S.obj': esp32VectorsObj } : undefined,
          objects,
          archivePaths: [
            ...ESP32_C3_ARDUINO_RECIPE.libArchives.map((archive) => `/sdk/lib/${archive}`),
            ...ESP32_C3_ARDUINO_RECIPE.ldArchives.map((archive) => `/sdk/ld/${archive}`)
          ],
          linkerScripts: {
            'memory.ld': memoryLd,
            'sections.ld': sectionsLd
          },
          linkerScriptPaths: ESP32_C3_ARDUINO_RECIPE.romLinkerScripts.map((script) => `/sdk/ld/${script}`),
          libraryPaths: ['/sdk/ld', '/sdk/lib'],
          undefinedSymbols: [...ESP32_C3_ARDUINO_RECIPE.undefinedSymbols],
          extraLinkerArgs: [...ESP32_C3_ARDUINO_RECIPE.extraLinkerArgs],
          target: build.target,
          targetOptions: build.targetOptions ?? ESP32_C3_ARDUINO_RECIPE.targetOptions,
          preopens: riscvEsp32Preopens
        })
      : await toolchain.linkEsp32Elf({
          objects,
          archives: sdk.archives,
          linkerScripts: { ...sdk.linkerScripts, 'sdk/memory.ld': memoryLd, 'sdk/sections.ld': sectionsLd },
          undefinedSymbols: [...ESP32_C3_ARDUINO_RECIPE.undefinedSymbols],
          extraLinkerArgs: [...ESP32_C3_ARDUINO_RECIPE.extraLinkerArgs],
          target: build.target,
          targetOptions: build.targetOptions,
          preopens: riscvEsp32Preopens
        });

    if (linkResult.bin.length > 24) {
      const validation = validateEsp32Image(linkResult.bin);
      if (!validation.valid) {
        throw new Error(`Generated ESP32-C3 firmware image failed validation: ${validation.errors.join('; ')}`);
      }
      if (!validation.hasAppDesc) {
        throw new Error('Generated ESP32-C3 firmware image is missing esp_app_desc_t metadata in DROM');
      }
    }
    return linkResult;
  };

  if (inoPaths.length > 0) {
    const tabs = Object.fromEntries(inoPaths.map((path) => [path, sourceFiles[path] ?? '']));
    const sketch = preprocessIno(tabs);
    generatedCpp = sketch.cpp;
    sourceMap = sketch.sourceMap;

    if (build.kind === 'bare-metal') {
      if (!build.startupSource || !build.linkerScript) {
        throw new Error(`Board '${board}' has an incomplete bare-metal build recipe`);
      }
      const startupValue = await host.readFile(`${project}/${build.startupSource}`, { encoding: 'utf8' });
      const linkerValue = await host.readFile(`${project}/${build.linkerScript}`, { encoding: 'utf8' });
      if (typeof startupValue !== 'string' || typeof linkerValue !== 'string') {
        throw new Error(`Firmware sources for '${board}' must be text files`);
      }
      generatedCpp = `${generatedCpp}\nextern "C" int main(void) { setup(); for (;;) { loop(); } return 0; }\n`;
      result = await toolchain.compileAndLinkBareMetal({
        source: generatedCpp,
        startupSource: startupValue,
        linkerScript: linkerValue,
        target: build.target,
        targetOptions: build.targetOptions,
        language: 'c++'
      });
    } else if (build.kind === 'firmware') {
      if (!hasEsp32FrameworkArchive) {
        throw new Error(`ESP32-C3 firmware linking is missing sdk/lib/libFrameworkArduino.a in the staged target SDK`);
      }
      if (!rawEsp32MemoryLd || !rawEsp32SectionsLd) {
        throw new Error(`ESP32-C3 firmware linking is missing memory.ld or sections.ld in the staged target SDK`);
      }
      const compileIncludeDirs = [...new Set([...riscvEsp32IncludeDirs, ...sdk.includeDirs])];
      const compiledApp = await toolchain.compileSource(generatedCpp, build.target, build.targetOptions, {
        language: 'c++',
        includeDirs: compileIncludeDirs,
        compilerFlags: riscvEsp32CompilerFlags,
        preopens: riscvEsp32Preopens,
        files: hasFullStagedEsp32Sdk ? undefined : sdk.files,
        defines,
        cacheDirectory: `${project}/.wicro/cache`
      });
      compiledObjects.push({ path: inoPaths[0] ?? 'sketch.cpp', object: compiledApp.object, cache: compiledApp.cache, diagnostics: compiledApp.diagnostics });

      /** @type {Record<string,Uint8Array>} */
      const linkObjects = { 'main.o': compiledApp.object };

      for (const sourcePath of sourcePaths.filter((path) => !/\.(ino|pde)$/i.test(path))) {
        const source = sourceFiles[sourcePath];
        const language = /\.(cpp|cxx|cc)$/i.test(sourcePath) ? 'c++' : /\.(s|S|asm)$/i.test(sourcePath) ? 'assembly' : 'c';
        const compiled = await toolchain.compileSource(source, build.target, build.targetOptions, {
          language,
          includeDirs: compileIncludeDirs,
          compilerFlags: language === 'c++' ? riscvEsp32CompilerFlags : [],
          preopens: riscvEsp32Preopens,
          files: hasFullStagedEsp32Sdk ? undefined : sdk.files,
          defines,
          cacheDirectory: `${project}/.wicro/cache`
        });
        compiledObjects.push({ path: sourcePath, object: compiled.object, cache: compiled.cache, diagnostics: compiled.diagnostics });
        linkObjects[`user-${compiledObjects.length}.o`] = compiled.object;
      }

      if (hasFullStagedEsp32Sdk && host.sdkCacheDirectory) {
        const sdkRoot = host.sdkCacheDirectory.replace(/\/+$/, '');
        for (const coreSource of ESP32_C3_ARDUINO_RECIPE.coreSources) {
          const coreText = await host.readFile(`${sdkRoot}/${coreSource}`, { encoding: 'utf8' });
          if (typeof coreText !== 'string') throw new Error(`Missing ESP32-C3 core source: ${coreSource}`);
          const coreObj = await toolchain.compileSource(coreText, build.target, build.targetOptions, {
            language: 'c++',
            includeDirs: compileIncludeDirs,
            compilerFlags: riscvEsp32CompilerFlags,
            preopens: riscvEsp32Preopens,
            defines,
            cacheDirectory: `${project}/.wicro/cache`
          });
          const objKey = `${coreSource.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'core'}.o`;
          linkObjects[objKey] = coreObj.object;
        }
      }

      result = await linkEsp32C3Firmware(linkObjects);
      result.diagnostics = [...new Set([...compiledObjects.flatMap((item) => item.diagnostics), ...result.diagnostics])];
    } else {
      result = await toolchain.compileSource(generatedCpp, build.target, build.targetOptions, {
        language: 'c++',
        includeDirs: [...new Set([...riscvEsp32IncludeDirs, ...sdk.includeDirs])],
        compilerFlags: riscvEsp32CompilerFlags,
        preopens: riscvEsp32Preopens,
        files: sdk.files,
        defines,
        cacheDirectory: `${project}/.wicro/cache`
      });
      compiledObjects.push({ path: inoPaths[0] ?? 'sketch.cpp', object: result.object, cache: result.cache, diagnostics: result.diagnostics });

      for (const sourcePath of sourcePaths.filter((path) => !/\.(ino|pde)$/i.test(path))) {
        const source = sourceFiles[sourcePath];
        const language = /\.(cpp|cxx|cc)$/i.test(sourcePath) ? 'c++' : /\.(s|S|asm)$/i.test(sourcePath) ? 'assembly' : 'c';
        const compiled = await toolchain.compileSource(source, build.target, build.targetOptions, {
          language,
          includeDirs: [...new Set([...riscvEsp32IncludeDirs, ...sdk.includeDirs])],
          compilerFlags: language === 'c++' ? riscvEsp32CompilerFlags : [],
          preopens: riscvEsp32Preopens,
          files: sdk.files,
          defines,
          cacheDirectory: `${project}/.wicro/cache`
        });
        compiledObjects.push({ path: sourcePath, object: compiled.object, cache: compiled.cache, diagnostics: compiled.diagnostics });
      }
    }
  } else if (build.kind === 'bare-metal') {
    if (!build.startupSource || !build.linkerScript) {
      throw new Error(`Board '${board}' has an incomplete bare-metal build recipe`);
    }
    const startupValue = await host.readFile(`${project}/${build.startupSource}`, { encoding: 'utf8' });
    const linkerValue = await host.readFile(`${project}/${build.linkerScript}`, { encoding: 'utf8' });
    const primarySource = sourcePaths.find((path) => /\.(cpp|cxx|cc|c)$/i.test(path));
    const sourceValue = primarySource ? sourceFiles[primarySource] : undefined;
    if (typeof sourceValue !== 'string' || typeof startupValue !== 'string' || typeof linkerValue !== 'string') {
      throw new Error(`Firmware sources for '${board}' must be text files`);
    }
    result = await toolchain.compileAndLinkBareMetal({
      source: sourceValue,
      startupSource: startupValue,
      linkerScript: linkerValue,
      target: build.target,
      targetOptions: build.targetOptions,
      language: /\.(cpp|cxx|cc)$/i.test(primarySource ?? '') ? 'c++' : 'c'
    });
  } else {
    const compilablePaths = sourcePaths.filter((path) => /\.(c|cpp|cxx|cc|s|S|asm)$/i.test(path));
    if (compilablePaths.length === 0) throw new Error(`No C, C++, or assembly sources found for project '${project}'`);

    for (const sourcePath of compilablePaths) {
      const language = /\.(cpp|cxx|cc)$/i.test(sourcePath) ? 'c++' : /\.(s|S|asm)$/i.test(sourcePath) ? 'assembly' : 'c';
      const compiled = await toolchain.compileSource(sourceFiles[sourcePath], build.target, build.targetOptions, {
        language,
        includeDirs: [...new Set([...riscvEsp32IncludeDirs, ...sdk.includeDirs])],
        compilerFlags: language === 'c++' ? riscvEsp32CompilerFlags : [],
        preopens: riscvEsp32Preopens,
        files: sdk.files,
        defines,
        cacheDirectory: `${project}/.wicro/cache`
      });
      compiledObjects.push({ path: sourcePath, object: compiled.object, cache: compiled.cache, diagnostics: compiled.diagnostics });
    }
    if (build.kind === 'firmware') {
      const firmwareObjects = Object.fromEntries(compiledObjects.map((item, index) => [`source-${index}.o`, item.object]));
      if (hasFullStagedEsp32Sdk && host.sdkCacheDirectory) {
        const sdkRoot = host.sdkCacheDirectory.replace(/\/+$/, '');
        const compileIncludeDirs = [...new Set([...riscvEsp32IncludeDirs, ...sdk.includeDirs])];
        for (const coreSource of ESP32_C3_ARDUINO_RECIPE.coreSources) {
          const coreText = await host.readFile(`${sdkRoot}/${coreSource}`, { encoding: 'utf8' });
          if (typeof coreText !== 'string') throw new Error(`Missing ESP32-C3 core source: ${coreSource}`);
          const coreObj = await toolchain.compileSource(coreText, build.target, build.targetOptions, {
            language: 'c++',
            includeDirs: compileIncludeDirs,
            compilerFlags: riscvEsp32CompilerFlags,
            preopens: riscvEsp32Preopens,
            defines,
            cacheDirectory: `${project}/.wicro/cache`
          });
          const objKey = `${coreSource.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'core'}.o`;
          firmwareObjects[objKey] = coreObj.object;
        }
      }
      result = await linkEsp32C3Firmware(firmwareObjects);
      result.diagnostics = [...new Set([...compiledObjects.flatMap((item) => item.diagnostics), ...result.diagnostics])];
    } else {
      result = {
        object: compiledObjects[0]?.object ?? new Uint8Array(0),
        target: build.target,
        cache: compiledObjects[0]?.cache ?? 'miss',
        diagnostics: [...new Set(compiledObjects.flatMap((item) => item.diagnostics))]
      };
    }
  }

  const output = build.output ?? '.wicro/build';
  if (generatedCpp) await host.writeFile(`${project}/${output}/sketch.cpp`, generatedCpp);
  for (const compiled of compiledObjects) {
    const objectName = compiled.path.split('/').pop()?.replace(/\.(ino|pde|c|cc|cpp|cxx|s|S|asm)$/i, '') ?? 'main';
    await host.writeFile(`${project}/${output}/${objectName}.o`, compiled.object);
  }
  if (compiledObjects.length > 0) {
    await host.writeFile(`${project}/${output}/main.o`, compiledObjects[0].object);
  }

  const compileCommands = sourcePaths
    .filter((path) => /\.(ino|pde|c|cc|cpp|cxx|s|S|asm)$/i.test(path))
    .map((path) => ({
      directory: `${project}/${output}`,
      file: `${project}/${path}`,
      arguments: [
        'clang++',
        `--target=${build.target}`,
        ...sdk.includeDirs.flatMap((directoryName) => ['-I', directoryName]),
        ...defines.flatMap((define) => ['-D', define]),
        ...(build.target === 'riscv32' ? riscvEsp32CompilerFlags : []),
        '-c',
        `${project}/${path}`
      ]
    }));
  await host.writeFile(`${project}/${output}/compile_commands.json`, JSON.stringify(compileCommands, null, 2));

  if ('elf' in result && 'bin' in result) {
    await host.writeFile(`${project}/${output}/firmware.elf`, result.elf);
    await host.writeFile(`${project}/${output}/firmware.bin`, result.bin);
  } else {
    await host.writeFile(`${project}/${output}/main.o`, result.object);
  }

  return {
    board,
    output,
    kind: build.kind,
    target: build.target,
    elf: 'elf' in result ? `${project}/${output}/firmware.elf` : undefined,
    bin: 'bin' in result ? `${project}/${output}/firmware.bin` : undefined,
    object: 'object' in result ? `${project}/${output}/main.o` : undefined,
    diagnostics: result.diagnostics,
    generatedCpp: generatedCpp ? `${project}/${output}/sketch.cpp` : undefined,
    sourceMap,
    sources: sourcePaths,
    compileCommands: `${project}/${output}/compile_commands.json`,
    objects: compiledObjects.map((item) => ({ path: item.path, cache: item.cache }))
  };
};
