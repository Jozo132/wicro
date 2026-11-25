/** @typedef {{runtimeVendorId:number,runtimeProductId:number,dfuVendorId:number,dfuProductId:number,interfaceNumber:number,alternateSetting:number,address:number,capacity:number,protocol:'dfuse'|'dfu',serialNumber?:string,ramAddress?:number,ramCapacity?:number}} CdcDfuProfile */

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
