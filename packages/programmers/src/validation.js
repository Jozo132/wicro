/**
 * Host-independent ESP32 flash partition and image validation helpers.
 * Zero Node.js imports so the exact same validation runs in Node.js and browsers.
 */

/**
 * Validate that an ESP32 application binary fits within the target partition.
 * @param {number} applicationSize
 * @param {number} [partitionOffset]
 * @param {number} [partitionCapacity]
 */
export const validateEsp32ApplicationPartition = (applicationSize, partitionOffset = 0x10000, partitionCapacity = 0x180000) => {
  if (!Number.isSafeInteger(applicationSize) || applicationSize <= 0) throw new Error('ESP32 application image size is invalid');
  if (!Number.isSafeInteger(partitionOffset) || partitionOffset < 0) throw new Error('ESP32 application partition offset is invalid');
  if (!Number.isSafeInteger(partitionCapacity) || partitionCapacity <= 0) throw new Error('ESP32 application partition capacity is invalid');
  if (applicationSize > partitionCapacity) throw new Error(`ESP32 application image (${applicationSize} bytes) exceeds partition capacity (${partitionCapacity} bytes)`);
  return { ok: true, partitionOffset, partitionCapacity, applicationSize };
};

/**
 * Validate ESP32 flash image magic bytes and required offsets.
 * @param {{address:number,data:Uint8Array}[]} files
 */
export const validateEsp32FlashImages = (files) => {
  if (files.length === 1 && files[0].address === 0x10000) {
    const application = files[0].data;
    if (!(application instanceof Uint8Array) || application.length === 0) throw new Error('ESP32 application image is empty');
    if (application[0] !== 0xe9) throw new Error('ESP32 application image magic is invalid');
    return { ok: true, addresses: [0x10000], bootloaderBytes: 0, partitionBytes: 0, applicationBytes: application.length };
  }

  const required = new Map([[0x0, 'bootloader'], [0x8000, 'partition'], [0x10000, 'application']]);
  for (const [address, role] of required) {
    const file = files.find((item) => item.address === address);
    if (!file) throw new Error(`Missing ESP32 ${role} image at 0x${address.toString(16)}`);
    if (!(file.data instanceof Uint8Array) || file.data.length === 0) throw new Error(`ESP32 ${role} image is empty`);
  }
  const bootloader = files.find((item) => item.address === 0x0)?.data;
  const partition = files.find((item) => item.address === 0x8000)?.data;
  const application = files.find((item) => item.address === 0x10000)?.data;
  if (bootloader && bootloader[0] !== 0xe9) throw new Error('ESP32 bootloader image magic is invalid');
  if (partition && partition[0] !== 0xaa) throw new Error('ESP32 partition table magic is invalid');
  if (application && application[0] !== 0xe9) throw new Error('ESP32 application image magic is invalid');
  return { ok: true, addresses: [...required.keys()], bootloaderBytes: bootloader?.length ?? 0, partitionBytes: partition?.length ?? 0, applicationBytes: application?.length ?? 0 };
};
