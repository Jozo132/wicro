/** @typedef {import('./registry.js').TargetOptions} TargetOptions */
/**
 * Canonical architecture descriptors shared by Node.js, browser, and VS Code hosts.
 * @type {readonly import('./registry.js').ArchitectureDescriptor[]}
 */
export const BUILTIN_ARCHITECTURES = Object.freeze([
  Object.freeze({
    id: 'riscv32',
    name: 'RISC-V 32-bit (ESP32-C/H)',
    triple: 'riscv32-esp-elf',
    elfMachine: 243,
    defaultFlags: Object.freeze(['-fno-builtin']),
    capabilities: Object.freeze(['compressed', 'embedded', 'wasm-compile', 'wasm-link']),
    buildTargetArgs: (/** @type {TargetOptions} */ targetOptions = {}) => [
      '--target=riscv32-esp-elf',
      `-march=${targetOptions.march ?? 'rv32imc'}`,
      `-mabi=${targetOptions.mabi ?? 'ilp32'}`
    ]
  }),
  Object.freeze({
    id: 'riscv64',
    name: 'RISC-V 64-bit',
    triple: 'riscv64-unknown-elf',
    elfMachine: 243,
    defaultFlags: Object.freeze([]),
    capabilities: Object.freeze(['64bit', 'wasm-compile']),
    buildTargetArgs: (/** @type {TargetOptions} */ targetOptions = {}) => [
      '--target=riscv64-unknown-elf',
      `-march=${targetOptions.march ?? 'rv64gc'}`,
      `-mabi=${targetOptions.mabi ?? 'lp64d'}`
    ]
  }),
  Object.freeze({
    id: 'xtensa',
    name: 'Xtensa LX6/LX7/LX106',
    triple: 'xtensa-esp-elf',
    elfMachine: 94,
    defaultFlags: Object.freeze([]),
    capabilities: Object.freeze(['embedded', 'wasm-compile']),
    buildTargetArgs: (/** @type {TargetOptions} */ targetOptions = {}) => [
      '--target=xtensa-esp-elf',
      `-mcpu=${targetOptions.mcpu ?? 'esp32'}`
    ]
  }),
  Object.freeze({
    id: 'armv6m',
    name: 'ARM Cortex-M0/M0+',
    triple: 'arm-none-eabi',
    elfMachine: 40,
    defaultFlags: Object.freeze([]),
    capabilities: Object.freeze(['thumb', 'embedded', 'wasm-compile', 'wasm-link']),
    buildTargetArgs: (/** @type {TargetOptions} */ targetOptions = {}) => [
      '--target=arm-none-eabi',
      `-mcpu=${targetOptions.mcpu ?? 'cortex-m0plus'}`,
      '-mthumb'
    ]
  }),
  Object.freeze({
    id: 'armv7-m',
    name: 'ARM Cortex-M3',
    triple: 'arm-none-eabi',
    elfMachine: 40,
    defaultFlags: Object.freeze([]),
    capabilities: Object.freeze(['thumb', 'embedded', 'wasm-compile', 'wasm-link']),
    buildTargetArgs: (/** @type {TargetOptions} */ targetOptions = {}) => [
      '--target=arm-none-eabi',
      `-mcpu=${targetOptions.mcpu ?? 'cortex-m3'}`,
      '-mthumb',
      '-mfloat-abi=soft'
    ]
  }),
  Object.freeze({
    id: 'armv7e-m',
    name: 'ARM Cortex-M4/M7',
    triple: 'arm-none-eabi',
    elfMachine: 40,
    defaultFlags: Object.freeze([]),
    capabilities: Object.freeze(['thumb', 'fpu', 'embedded', 'wasm-compile', 'wasm-link']),
    buildTargetArgs: (/** @type {TargetOptions} */ targetOptions = {}) => [
      '--target=arm-none-eabi',
      `-mcpu=${targetOptions.mcpu ?? 'cortex-m4'}`,
      '-mthumb',
      '-mfloat-abi=hard'
    ]
  }),
  Object.freeze({
    id: 'armv8m-mainline',
    name: 'ARM Cortex-M33',
    triple: 'arm-none-eabi',
    elfMachine: 40,
    defaultFlags: Object.freeze([]),
    capabilities: Object.freeze(['thumb', 'fpu', 'trustzone', 'embedded', 'wasm-compile', 'wasm-link']),
    buildTargetArgs: (/** @type {TargetOptions} */ targetOptions = {}) => [
      '--target=arm-none-eabi',
      `-mcpu=${targetOptions.mcpu ?? 'cortex-m33'}`,
      '-mthumb',
      '-mfloat-abi=hard'
    ]
  }),
  Object.freeze({
    id: 'avr',
    name: 'AVR 8-bit',
    triple: 'avr',
    elfMachine: 83,
    defaultFlags: Object.freeze([]),
    capabilities: Object.freeze(['8bit', 'embedded', 'wasm-compile']),
    buildTargetArgs: (/** @type {TargetOptions} */ targetOptions = {}) => [
      '--target=avr',
      `-mmcu=${targetOptions.mcu ?? 'atmega328p'}`
    ]
  })
]);

/**
 * Resolve compiler target arguments using registered architectures (falls back to built-ins).
 * @param {string} target
 * @param {import('./registry.js').TargetOptions} [targetOptions]
 * @param {import('./registry.js').WicroPlatformRegistry} [registry]
 * @returns {string[]}
 */
export const resolveArchitectureTargetArgs = (target, targetOptions = {}, registry) => {
  const registered = registry?.getArchitecture(target);
  if (registered) return registered.buildTargetArgs(targetOptions);
  const builtin = BUILTIN_ARCHITECTURES.find((item) => item.id === target);
  if (builtin) return builtin.buildTargetArgs(targetOptions);
  throw new Error(`Unsupported LLVM target: ${target}`);
};
