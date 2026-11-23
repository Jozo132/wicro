import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { main as wicroMain } from '../packages/wicro/src/index.js';
import { validateEsp32Image } from '../packages/runtime/src/index.js';

const hardwareEnabled = process.env.WICRO_ESP32_HARDWARE === '1';

test('ESP32-C3 Wicro Arduino WASM hardware end-to-end acceptance (60s stability)', { skip: !hardwareEnabled }, async () => {
  const projectDir = resolve('examples/esp32-c3-supermini/blink');
  const elfPath = resolve(projectDir, '.wicro/build/firmware.elf');
  const binPath = resolve(projectDir, '.wicro/build/firmware.bin');

  // 1. Clean WASM compile + WASM link + ESP32 BIN generation
  await rm(resolve(projectDir, '.wicro'), { recursive: true, force: true });
  const buildCode = await wicroMain(['build', `--project=${projectDir}`]);
  assert.equal(buildCode, 0, 'Wicro WASM build failed');

  // 2. ELF validation (ELF32 RISC-V with valid IRAM entry point)
  const elf = await readFile(elfPath);
  assert.equal(elf.subarray(0, 4).toString('hex'), '7f454c46', 'firmware.elf is not ELF');
  assert.equal(elf.readUInt16LE(18), 243, 'firmware.elf e_machine is not EM_RISCV (243)');
  const entry = elf.readUInt32LE(24);
  assert.ok(entry >= 0x40380000 && entry < 0x403d0000, `Unexpected ELF entry 0x${entry.toString(16)}`);

  // 3. Independent ESP32-C3 image validation (header, 64KB MMU alignment, app_desc, checksum, SHA-256)
  const bin = await readFile(binPath);
  const imageCheck = await validateEsp32Image(bin);
  assert.equal(imageCheck.valid, true, `Invalid ESP32-C3 BIN: ${imageCheck.errors.join('; ')}`);
  assert.equal(imageCheck.chipId, 5, 'Expected ESP32-C3 chip_id=5');
  assert.equal(imageCheck.hasAppDesc, true, 'Missing esp_app_desc_t magic in DROM segment');
  assert.equal(imageCheck.sha256Valid, true, 'Invalid ESP32-C3 image SHA-256');
  assert.equal(imageCheck.entry, entry, 'BIN entry point does not match ELF entry point');

  // 4. Automatic USB-JTAG ROM entry, app-only flash at 0x10000, byte-for-byte readback, and reboot
  const { Esp32C3NodeProgrammer } = await import('../packages/programmers/src/index.js');
  const programmer = new Esp32C3NodeProgrammer({ debugLogging: false });
  const flash = await programmer.writeFlash([{ address: 0x10000, data: bin }], {
    baudRate: 115200,
    resetMode: 'touch_1200',
    verifyReadback: true
  });
  assert.equal(flash.ok, true, 'Flash failed');
  assert.equal(flash.chip, 'ESP32-C3');
  assert.equal(flash.readback?.verified, true, 'Flash readback not verified');
  assert.equal(flash.readback?.matched, true, 'Flash readback mismatch');
  assert.equal(flash.reboot?.ok, true, `Reboot failed: ${flash.reboot?.error}`);

  // 5. Monitor USB Serial/JTAG console for 65 seconds continuously
  /** @type {string[]} */
  const lines = [];
  const monitor = await programmer.monitor({
    path: flash.path,
    baudRate: 115200,
    onLine: (line) => lines.push(line.trim())
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 65000));
  await monitor.close();

  const readyIndex = lines.indexOf('WICRO_SERIAL_READY');
  assert.ok(readyIndex >= 0, `missing WICRO_SERIAL_READY in serial output (${lines.slice(0, 15).join(' | ')})`);

  const postReadyLines = lines.slice(readyIndex + 1);
  const onCount = postReadyLines.filter((line) => line === 'LED ON').length;
  const offCount = postReadyLines.filter((line) => line === 'LED OFF').length;
  assert.ok(onCount >= 50, `Expected >=50 LED ON messages over 65s, got ${onCount}`);
  assert.ok(offCount >= 50, `Expected >=50 LED OFF messages over 65s, got ${offCount}`);

  // Fail on any unexpected ROM reset or panic after initial boot
  const unexpectedResets = postReadyLines.filter((line) => /rst:0x[0-9a-f]+|Guru Meditation|Backtrace:|assert failed/i.test(line));
  assert.equal(unexpectedResets.length, 0, `Unexpected reset/crash after boot: ${unexpectedResets.join(' | ')}`);

  // 6. Second build succeeds offline using cached SDK and compiler assets
  const offlineBuildCode = await wicroMain(['build', `--project=${projectDir}`]);
  assert.equal(offlineBuildCode, 0, 'Second offline cached build failed');
});
