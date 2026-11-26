/** @typedef {{runtimeVendorId:number,runtimeProductId:number,dfuVendorId:number,dfuProductId:number,interfaceNumber:number,alternateSetting:number,address:number,capacity:number,protocol:'dfuse'|'dfu',serialNumber?:string,ramAddress?:number,ramCapacity?:number,fallbackSectors?:Array<{address:number,size:number,readable:boolean,erasable:boolean,writable:boolean}>}} CdcDfuProfile */

/** @param {Uint8Array} data @param {CdcDfuProfile} profile */
export const validateCortexMImage = (data, profile) => {
  if (data.length < 8) throw new Error('ARM firmware must include a vector table');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const stack = view.getUint32(0, true);
  const reset = view.getUint32(4, true);
  if (profile.ramAddress !== undefined && profile.ramCapacity !== undefined && (stack <= profile.ramAddress || stack > profile.ramAddress + profile.ramCapacity || stack % 4)) throw new Error('Initial stack pointer is outside the configured MCU RAM');
  if (!(reset & 1) || reset - 1 < profile.address || reset - 1 >= profile.address + data.length) throw new Error('Reset vector is outside this firmware image or is not a Thumb entry');
  if (data.length > profile.capacity) throw new Error('Firmware exceeds the configured application capacity');
  return { stack, reset };
};

/** Explicit application bounds for the STM32F401RC; other MCUs require their own profile. */
export const STM32F401RC_CDC_DFU_PROFILE = Object.freeze({
  runtimeVendorId: 0x0483, runtimeProductId: 0x5740, dfuVendorId: 0x0483, dfuProductId: 0xdf11,
  interfaceNumber: 0, alternateSetting: 0, address: 0x08000000, capacity: 262144,
  ramAddress: 0x20000000, ramCapacity: 65536, protocol: /** @type {const} */ ('dfuse')
});

/**
 * Device-independent STM32 DFU profiles. Sector geometry still comes from the
 * selected DFU alternate; these values provide MCU flash/RAM bounds and USB IDs.
 * @param {{address?:number,capacity:number,ramAddress:number,ramCapacity:number,interfaceNumber?:number,alternateSetting?:number,dfuProductId?:number,fallbackSectors?:Array<{address:number,size:number,readable:boolean,erasable:boolean,writable:boolean}>}} options
 * @returns {CdcDfuProfile}
 */
export const createStm32DfuProfile = (options) => Object.freeze({
  runtimeVendorId: 0x0483,
  runtimeProductId: 0x5740,
  dfuVendorId: 0x0483,
  dfuProductId: options.dfuProductId ?? 0xdf11,
  interfaceNumber: options.interfaceNumber ?? 0,
  alternateSetting: options.alternateSetting ?? 0,
  address: options.address ?? 0x08000000,
  capacity: options.capacity,
  protocol: /** @type {const} */ ('dfuse'),
  ramAddress: options.ramAddress,
  ramCapacity: options.ramCapacity,
  fallbackSectors: options.fallbackSectors
});

const sectors = (address, groups) => {
  /** @type {Array<{address:number,size:number,readable:boolean,erasable:boolean,writable:boolean}>} */
  const result = [];
  let cursor = address;
  for (const group of groups) {
    for (let index = 0; index < group.count; index++) {
      result.push({ address: cursor, size: group.size, readable: true, erasable: true, writable: true });
      cursor += group.size;
    }
  }
  return result;
};

export const STM32_DFU_PROFILES = Object.freeze({
  'STM32F103C8': createStm32DfuProfile({ capacity: 65536, ramAddress: 0x20000000, ramCapacity: 20480, fallbackSectors: sectors(0x08000000, [{ count: 64, size: 1024 }]) }),
  'STM32F103CB': createStm32DfuProfile({ capacity: 131072, ramAddress: 0x20000000, ramCapacity: 20480, fallbackSectors: sectors(0x08000000, [{ count: 128, size: 1024 }]) }),
  'STM32F411CE': createStm32DfuProfile({ capacity: 524288, ramAddress: 0x20000000, ramCapacity: 131072, fallbackSectors: sectors(0x08000000, [{ count: 4, size: 16384 }, { count: 1, size: 65536 }, { count: 3, size: 131072 }]) }),
  'STM32F401RC': { ...STM32F401RC_CDC_DFU_PROFILE, fallbackSectors: sectors(0x08000000, [{ count: 4, size: 16384 }, { count: 1, size: 65536 }, { count: 1, size: 131072 }]) },
  'STM32F401RE': createStm32DfuProfile({ capacity: 524288, ramAddress: 0x20000000, ramCapacity: 98304, fallbackSectors: sectors(0x08000000, [{ count: 4, size: 16384 }, { count: 1, size: 65536 }, { count: 3, size: 131072 }]) }),
  'STM32H723VG': createStm32DfuProfile({ address: 0x08000000, capacity: 1048576, ramAddress: 0x24000000, ramCapacity: 564992, fallbackSectors: sectors(0x08000000, [{ count: 8, size: 131072 }]) })
});

/** @param {string} mcu */
export const resolveStm32DfuProfile = (mcu) => {
  const key = mcu.trim().toUpperCase();
  if (key === 'STM32F103C8') return STM32_DFU_PROFILES.STM32F103C8;
  if (key === 'STM32F103CB') return STM32_DFU_PROFILES.STM32F103CB;
  if (key === 'STM32F411CE') return STM32_DFU_PROFILES.STM32F411CE;
  if (key === 'STM32F401RC') return STM32_DFU_PROFILES.STM32F401RC;
  if (key === 'STM32F401RE') return STM32_DFU_PROFILES.STM32F401RE;
  if (key === 'STM32H723VG') return STM32_DFU_PROFILES.STM32H723VG;
  return null;
};
