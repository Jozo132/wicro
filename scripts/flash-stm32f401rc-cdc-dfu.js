import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NodeCdcDfuProgrammer } from '../packages/programmers/src/cdc-dfu-node.js';
import { STM32F401RC_CDC_DFU_PROFILE } from '../packages/programmers/src/cdc-dfu-profile.js';

const binary = process.argv.find((arg) => arg.startsWith('--bin='))?.slice(6);
const serialNumber = process.argv.find((arg) => arg.startsWith('--serial='))?.slice(9);
if (!binary || !serialNumber) throw new Error('Explicit --bin=firmware.bin and --serial=USB_SERIAL are required. This command erases/programs application flash.');
const programmer = new NodeCdcDfuProgrammer({
  profile: { ...STM32F401RC_CDC_DFU_PROFILE, serialNumber },
  onLog: (message) => console.error(message),
  onProgress: (event) => console.error(`${event.stage}: ${event.message}`)
});
const result = await programmer.writeFlash(new Uint8Array(await readFile(resolve(binary))), { trigger: !process.argv.includes('--manual-dfu'), verifyReadback: true });
const report = { timestamp: new Date().toISOString(), binary: resolve(binary), ...result };
const reportPath = process.argv.find((arg) => arg.startsWith('--report='))?.slice(9);
if (reportPath) await writeFile(resolve(reportPath), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
