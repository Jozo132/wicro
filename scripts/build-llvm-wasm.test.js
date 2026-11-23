import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildDefaults,
  findWindowsSdk,
  parseVsDevShellOutput,
  toGitBashPath,
  verifyWasiSdk,
  validateWasmArtifact,
  verifyCachedArtifacts,
  wasiSdkAsset
} from './build-llvm-wasm.js';

const manifest = JSON.parse(await readFile(new URL('../toolchain/llvm-wasm/manifest.json', import.meta.url), 'utf8'));

test('pinned LLVM source revisions and targets remain reproducible', () => {
  assert.equal(buildDefaults.espWasmRef, 'dceb9e3126898359bff8ab9e44bec5b65d87b5d3');
  assert.equal(buildDefaults.llvmRef, 'esp-20.1.1_20250829');
  assert.equal(buildDefaults.llvmProjectCommit, '50f388758bdf0b0d99018a6f2b1d3402bdb51002');
  assert.equal(buildDefaults.llvmTargets, 'ARM;AVR;RISCV');
  assert.equal(buildDefaults.wasiSdkVersion, '34.0');
});

test('WASI SDK asset mapping covers native Windows, Linux, and macOS', () => {
  assert.equal(wasiSdkAsset('win32', 'x64'), 'wasi-sdk-34.0-x86_64-windows.tar.gz');
  assert.equal(wasiSdkAsset('linux', 'x64'), 'wasi-sdk-34.0-x86_64-linux.tar.gz');
  assert.equal(wasiSdkAsset('linux', 'arm64'), 'wasi-sdk-34.0-arm64-linux.tar.gz');
  assert.equal(wasiSdkAsset('darwin', 'x64'), 'wasi-sdk-34.0-x86_64-macos.tar.gz');
  assert.equal(wasiSdkAsset('darwin', 'arm64'), 'wasi-sdk-34.0-arm64-macos.tar.gz');
  assert.equal(wasiSdkAsset('aix', 'x64'), null);
});

test('cache verifies the manifest SHA-256 and distinguishes mismatches', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'wicro-llvm-cache-test-'));
  try {
    await mkdir(cache, { recursive: true });
    const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    await writeFile(join(cache, 'llvm.wasm'), wasm);

    const mismatch = await verifyCachedArtifacts(cache, manifest);
    assert.equal(mismatch.llvmStatus, 'mismatch');

    const verifiedManifest = structuredClone(manifest);
    verifiedManifest.integrity['llvm.wasm'] = createHash('sha256').update(wasm).digest('hex');
    const verified = await verifyCachedArtifacts(cache, verifiedManifest);
    assert.equal(verified.llvmStatus, 'verified');
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});

test('Windows paths convert consistently to Git Bash paths', () => {
  assert.equal(toGitBashPath('C:\\Program Files\\LLVM\\bin\\cl.exe'), '/c/Program Files/LLVM/bin/cl.exe');
  assert.equal(toGitBashPath('D:\\SDK\\bin\\rc.exe'), '/d/SDK/bin/rc.exe');
  assert.equal(toGitBashPath('/c/llvm-tools/ninja.exe'), '/c/llvm-tools/ninja.exe');
});

test('Windows SDK discovery reports missing rc.exe and SDK paths separately', () => {
  const sdk = findWindowsSdk({});
  assert.equal(sdk.rc, null);
  assert.equal(sdk.windowsSdk, null);

  const initialized = findWindowsSdk({
    WindowsSdkDir: 'C:\\Program Files (x86)\\Windows Kits\\10\\',
    INCLUDE: 'C:\\Include',
    LIB: 'C:\\Lib'
  });
  assert.equal(initialized.windowsSdk, 'C:\\Program Files (x86)\\Windows Kits\\10\\');
  assert.equal(initialized.sdkInclude, 'C:\\Include');
  assert.equal(initialized.sdkLib, 'C:\\Lib');
});

test('WASI SDK validation names every missing component', async () => {
  const wasi = await mkdtemp(join(tmpdir(), 'wicro-wasi-test-'));
  try {
    const result = verifyWasiSdk(wasi, manifest);
    assert.equal(result.valid, false);
    assert.equal(result.missing.length, 4);
    assert.match(result.diagnostics[0], /WASI SDK 34\.0 is incomplete/);
  } finally {
    await rm(wasi, { recursive: true, force: true });
  }
});

test('VsDevCmd environment output preserves MSVC and Windows SDK variables', () => {
  const parsed = parseVsDevShellOutput('INCLUDE=C:\\Include\r\nLIB=C:\\Lib\r\nWindowsSdkDir=C:\\SDK\\\r\nVCToolsInstallDir=C:\\VC\\\r\nPATH=C:\\VS\\bin;C:\\Windows\\System32');
  assert.equal(parsed.INCLUDE, 'C:\\Include');
  assert.equal(parsed.LIB, 'C:\\Lib');
  assert.equal(parsed.WindowsSdkDir, 'C:\\SDK\\');
  assert.equal(parsed.VCToolsInstallDir, 'C:\\VC\\');
  assert.match(parsed.PATH ?? '', /C:\\VS\\bin/);
});

test('artifact validation rejects non-WASM bytes', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'wicro-llvm-artifact-test-'));
  try {
    await writeFile(join(cache, 'llvm.wasm'), Buffer.from('not wasm'));
    const result = await validateWasmArtifact(cache, manifest);
    assert.equal(result.valid, false);
    assert.match(result.diagnostics[0], /invalid WASM header/);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});
