import { extractArchiveMember, patchElfSectionFlags } from '../../../runtime/src/index.js';

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

/**
 * Inspect the staged ESP32-C3 SDK directory via the host adapter.
 * @param {import('../index.js').WicroHostAdapter} host
 * @param {{archives:Record<string,Uint8Array>,linkerScripts:Record<string,string>}} sdk
 */
const probeStagedEsp32Sdk = async (host, sdk) => {
  let rawMemoryLd = sdk.linkerScripts['sdk/memory.ld'];
  let rawSectionsLd = sdk.linkerScripts['sdk/sections.ld'];
  let hasFrameworkArchive = Boolean(sdk.archives['sdk/lib/libFrameworkArduino.a']);
  /** @type {Uint8Array|undefined} */
  let vectorsObj;
  let hasFullStagedSdk = false;

  if (host.sdkCacheDirectory) {
    const sdkRoot = host.sdkCacheDirectory.replace(/\/+$/, '');
    if (!hasFrameworkArchive) {
      try {
        const probe = await host.readFile(`${sdkRoot}/lib/libFrameworkArduino.a`, { encoding: 'binary' });
        if (probe instanceof Uint8Array && probe.length > 0) hasFrameworkArchive = true;
      } catch {
        // Link step fails closed below.
      }
    }
    if (!rawMemoryLd) {
      for (const candidate of [`${sdkRoot}/ld/memory.ld`, `${sdkRoot}/memory.ld`]) {
        try {
          const text = await host.readFile(candidate, { encoding: 'utf8' });
          if (typeof text === 'string') { rawMemoryLd = text; break; }
        } catch {
          // Try next candidate.
        }
      }
    }
    if (!rawSectionsLd) {
      for (const candidate of [`${sdkRoot}/ld/sections.ld`, `${sdkRoot}/sections.ld`]) {
        try {
          const text = await host.readFile(candidate, { encoding: 'utf8' });
          if (typeof text === 'string') { rawSectionsLd = text; break; }
        } catch {
          // Try next candidate.
        }
      }
    }
    try {
      const libriscv = await host.readFile(`${sdkRoot}/lib/libriscv.a`, { encoding: 'binary' });
      if (libriscv instanceof Uint8Array && libriscv.length > 8) {
        vectorsObj = patchElfSectionFlags(extractArchiveMember(libriscv, 'vectors.S.obj'), '.exception_vectors.text', 0x6);
        hasFullStagedSdk = true;
      }
    } catch {
      // Minimal SDKs without libriscv.a remain supported for unit tests.
    }
  }

  return { rawMemoryLd, rawSectionsLd, hasFrameworkArchive, vectorsObj, hasFullStagedSdk };
};

/** @type {import('./registry.js').PlatformAdapter} */
export const esp32C3PlatformAdapter = Object.freeze({
  id: 'espressif-esp32c3',
  family: 'esp32',
  architectures: Object.freeze(['riscv32']),
  frameworks: Object.freeze(['arduino', 'esp-idf']),
  defaultFirmwareFormat: 'esp32-c3-bin',
  programmerId: 'esp32-c3-usb-jtag',

  matchesBoard(board) {
    return board.build.target === 'riscv32' && board.build.kind === 'firmware';
  },

  async resolveCompileConfig({ host, projectManifest, sdk }) {
    const probed = await probeStagedEsp32Sdk(host, sdk);
    const buildSection = /** @type {{flags?:string[],defines?:string[]}|undefined} */ (projectManifest.build);
    const extraFlags = Array.isArray(buildSection?.flags) ? buildSection.flags : [];
    const extraDefines = Array.isArray(buildSection?.defines) ? buildSection.defines : [];

    /** @type {Array<{name:string,source:string,language:'c'|'c++'|'assembly'}>} */
    const extraUnits = [];
    if (probed.hasFullStagedSdk && host.sdkCacheDirectory) {
      const sdkRoot = host.sdkCacheDirectory.replace(/\/+$/, '');
      for (const coreSource of ESP32_C3_ARDUINO_RECIPE.coreSources) {
        const coreText = await host.readFile(`${sdkRoot}/${coreSource}`, { encoding: 'utf8' });
        if (typeof coreText !== 'string') throw new Error(`Missing ESP32-C3 core source: ${coreSource}`);
        const objBase = coreSource.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'core';
        extraUnits.push({ name: `${objBase}.o`, source: coreText, language: 'c++' });
      }
    }

    return {
      compilerFlags: [...ESP32_C3_ARDUINO_RECIPE.compilerFlags, ...extraFlags],
      includeDirs: [...new Set([...ESP32_C3_ARDUINO_RECIPE.includeDirs, ...sdk.includeDirs])],
      defines: [...ESP32_C3_ARDUINO_RECIPE.defines, ...extraDefines],
      preopens: host.sdkCacheDirectory ? { '/sdk': host.sdkCacheDirectory } : undefined,
      files: probed.hasFullStagedSdk ? undefined : sdk.files,
      extraUnits
    };
  },

  /** @returns {Promise<import('./registry.js').PlatformLinkPlan>} */
  async prepareLinkPlan({ host, board, compiledObjects, sdk }) {
    const probed = await probeStagedEsp32Sdk(host, sdk);
    if (!probed.hasFrameworkArchive) {
      throw new Error('ESP32-C3 firmware linking is missing sdk/lib/libFrameworkArduino.a in the staged target SDK');
    }
    if (!probed.rawMemoryLd || !probed.rawSectionsLd) {
      throw new Error('ESP32-C3 firmware linking is missing memory.ld or sections.ld in the staged target SDK');
    }

    const { memoryLd, sectionsLd } = prepareEsp32C3LinkerScripts(probed.rawMemoryLd, probed.rawSectionsLd);
    const preopens = host.sdkCacheDirectory ? { '/sdk': host.sdkCacheDirectory } : undefined;
    const firmwareFormat = board.build.firmwareFormat ?? 'esp32-c3-bin';

    if (probed.hasFullStagedSdk) {
      /** @type {Record<string, string|Uint8Array>} */
      const linkerScripts = {
        'memory.ld': memoryLd,
        'sections.ld': sectionsLd
      };
      return {
        preObjects: probed.vectorsObj ? { 'vectors.S.obj': probed.vectorsObj } : undefined,
        objects: compiledObjects,
        archivePaths: [
          ...ESP32_C3_ARDUINO_RECIPE.libArchives.map((archive) => `/sdk/lib/${archive}`),
          ...ESP32_C3_ARDUINO_RECIPE.ldArchives.map((archive) => `/sdk/ld/${archive}`)
        ],
        linkerScripts,
        linkerScriptPaths: ESP32_C3_ARDUINO_RECIPE.romLinkerScripts.map((script) => `/sdk/ld/${script}`),
        libraryPaths: ['/sdk/ld', '/sdk/lib'],
        undefinedSymbols: [...ESP32_C3_ARDUINO_RECIPE.undefinedSymbols],
        extraLinkerArgs: [...ESP32_C3_ARDUINO_RECIPE.extraLinkerArgs],
        preopens,
        firmwareFormat
      };
    }

    /** @type {Record<string, string|Uint8Array>} */
    const stagedLinkerScripts = { ...sdk.linkerScripts, 'sdk/memory.ld': memoryLd, 'sdk/sections.ld': sectionsLd };
    return {
      objects: compiledObjects,
      archives: sdk.archives,
      linkerScripts: stagedLinkerScripts,
      undefinedSymbols: [...ESP32_C3_ARDUINO_RECIPE.undefinedSymbols],
      extraLinkerArgs: [...ESP32_C3_ARDUINO_RECIPE.extraLinkerArgs],
      preopens,
      firmwareFormat
    };
  }
});
