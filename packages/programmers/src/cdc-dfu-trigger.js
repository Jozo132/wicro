/** Exact host-side semantics ported from jozo132/cdc-dfu 1.1.2 extra_script.py. */
export const CDC_DFU_TRIGGER_STEPS = Object.freeze([
  { dtr: true, delayMs: 0 },
  { dtr: false, delayMs: 50 }, { dtr: true, delayMs: 50 },
  { dtr: false, delayMs: 50 }, { dtr: true, delayMs: 50 },
  { dtr: false, delayMs: 50 }, { dtr: false, delayMs: 50 }
].map((step) => Object.freeze(step)));
export const CDC_DFU_MAGIC = new TextEncoder().encode('DFU!');

/** @param {{setDtr:(value:boolean)=>Promise<void>,write:(bytes:Uint8Array)=>Promise<void>}} transport */
export const triggerCdcDfu = async (transport) => {
  for (const step of CDC_DFU_TRIGGER_STEPS) {
    await transport.setDtr(step.dtr);
    if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
  }
  await transport.write(Uint8Array.from(CDC_DFU_MAGIC));
};
