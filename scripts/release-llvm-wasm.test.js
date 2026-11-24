import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  bumpReleaseVersion,
  classifyLlvmReleases,
  discoverGitHubReleases,
  fetchGitHubWithRetry,
  generateManifest,
  generateSha256Sums,
  inspectLocalArtifacts,
  parseLlvmReleaseTag,
  validateManifest,
  validateWasmStructure
} from './release-llvm-wasm.js';

const existingManifest = JSON.parse(await readFile(new URL('../toolchain/llvm-wasm/manifest.json', import.meta.url), 'utf8'));

test('first LLVM WASM release proposes 1.0.0', () => {
  assert.equal(bumpReleaseVersion('patch', null), '1.0.0');
  assert.equal(parseLlvmReleaseTag('llvm-wasm-v1.0.0'), '1.0.0');
});

test('patch minor and major bumps use semantic versions', () => {
  assert.equal(bumpReleaseVersion('patch', '1.2.3'), '1.2.4');
  assert.equal(bumpReleaseVersion('minor', '1.2.3'), '1.3.0');
  assert.equal(bumpReleaseVersion('major', '1.2.3'), '2.0.0');
});

test('release classification filters unrelated tags and sorts SemVer', () => {
  const classified = classifyLlvmReleases([
    { tag_name: 'app-v9.0.0', draft: false, prerelease: false },
    { tag_name: 'llvm-wasm-v1.2.0', draft: false, prerelease: false },
    { tag_name: 'llvm-wasm-v1.10.0', draft: false, prerelease: true },
    { tag_name: 'llvm-wasm-v1.1.0', draft: true, prerelease: false },
    { tag_name: 'llvm-wasm-v1.0.1', draft: false, prerelease: false },
    { tag_name: 'llvm-wasm-v1.11.0', tag_only: true }
  ]);
  assert.equal(classified.published.length, 2);
  assert.equal(classified.draft.length, 1);
  assert.equal(classified.prerelease.length, 1);
  assert.equal(classified.tagOnly.length, 1);
  assert.equal(classified.published[0].tag_name, 'llvm-wasm-v1.2.0');
});

test('tag-only LLVM WASM versions are distinguished from releases', () => {
  const classified = classifyLlvmReleases([
    { tag_name: 'llvm-wasm-v2.0.0', tag_only: true },
    { tag_name: 'llvm-wasm-v1.0.0', draft: false, prerelease: false }
  ]);
  assert.equal(classified.tagOnly[0].tag_name, 'llvm-wasm-v2.0.0');
  assert.equal(classified.published[0].tag_name, 'llvm-wasm-v1.0.0');
});

test('GitHub discovery filters and paginates release endpoints', async () => {
  let releasePageCalls = 0;
  let tagPageCalls = 0;
  const fetchImpl = /** @type {typeof fetch} */ (async (url) => {
    const text = String(url);
    if (text.includes('/releases?')) {
      releasePageCalls += 1;
      const pageMatch = /[?&]page=(\d+)/.exec(text);
      const page = pageMatch ? Number(pageMatch[1]) : 1;
      if (page === 1) {
        const batch = Array.from({ length: 100 }, (_, index) => ({ tag_name: `sdk-v1.${index}.0`, draft: false, prerelease: false }));
        return /** @type {any} */ ({ ok: true, status: 200, json: async () => batch });
      }
      return /** @type {any} */ ({ ok: true, status: 200, json: async () => [{ tag_name: 'llvm-wasm-v1.0.0', draft: false, prerelease: false }] });
    }
    if (text.includes('/git/matching-refs/tags/')) {
      tagPageCalls += 1;
      return /** @type {any} */ ({ ok: true, status: 200, json: async () => [] });
    }
    throw new Error(`Unexpected URL ${text}`);
  });

  const releases = await discoverGitHubReleases('Jozo132/wicro', { fetchImpl, token: null, retries: 1 });
  assert.equal(releasePageCalls, 2);
  assert.equal(tagPageCalls, 1);
  assert.equal(releases.filter((release) => parseLlvmReleaseTag(release.tag_name)).length, 1);
});

test('network failures retry before surfacing an error', async () => {
  let attempts = 0;
  const fetchImpl = /** @type {typeof fetch} */ (async () => {
    attempts += 1;
    throw new Error('offline');
  });
  await assert.rejects(() => fetchGitHubWithRetry(fetchImpl, 'https://example.invalid', {}, 3), /offline/);
  assert.equal(attempts, 3);
});

test('WASM validation rejects missing and corrupted artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wicro-release-artifacts-'));
  try {
    await mkdir(join(root, 'empty'), { recursive: true });
    const missing = await inspectLocalArtifacts(join(root, 'empty'), existingManifest);
    assert.equal(missing.valid, false);
    assert.match(missing.artifacts[0].diagnostics[0], /missing/);

    await writeFile(join(root, 'llvm.wasm'), Buffer.from('not wasm'));
    await writeFile(join(root, 'ld.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00]));
    const corrupted = await inspectLocalArtifacts(root, existingManifest);
    assert.equal(corrupted.valid, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('WASM structure validation accepts a minimal valid module', () => {
  const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00]);
  assert.equal(validateWasmStructure(wasm).valid, true);
  assert.equal(validateWasmStructure(Buffer.from([0x00, 0x61, 0x73, 0x6d])).valid, false);
});

test('manifest generation pins URLs, hashes and sizes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wicro-release-manifest-'));
  try {
    const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00]);
    await writeFile(join(root, 'llvm.wasm'), wasm);
    await writeFile(join(root, 'ld.wasm'), wasm);
    const local = await inspectLocalArtifacts(root, existingManifest);
    const manifest = /** @type {Record<string,unknown>} */ (generateManifest(existingManifest, '1.0.0', 'Jozo132/wicro', 'llvm-wasm-v1.0.0', local, 'none', root));
  const validation = validateManifest(manifest);
  assert.equal(validation.valid, true);
  assert.equal(manifest.version, '1.0.0');
  const artifacts = /** @type {Record<string,Record<string,unknown>>} */ (manifest.artifacts);
  const integrity = /** @type {Record<string,string>} */ (manifest.integrity);
  const release = /** @type {Record<string,unknown>} */ (manifest.release);
  assert.equal(artifacts.clang.filename, 'llvm.wasm');
  assert.match(String(artifacts.clang.url), /releases\/download\/llvm-wasm-v1\.0\.0\/llvm\.wasm$/);
  assert.match(integrity['llvm.wasm'], /^[a-f0-9]{64}$/);
  assert.equal(release.tag, 'llvm-wasm-v1.0.0');

    const sums = generateSha256Sums(manifest);
    assert.match(sums, /^([a-f0-9]{64}  (llvm|ld)\.wasm\n){2}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('compressed manifest metadata records compressed and uncompressed hashes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wicro-release-compression-'));
  try {
    const wasm = Buffer.alloc(1026, 0);
    wasm.set([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0xe7, 0x07]);
    await writeFile(join(root, 'llvm.wasm'), wasm);
    await writeFile(join(root, 'ld.wasm'), wasm);
    const local = await inspectLocalArtifacts(root, existingManifest);
    const manifest = /** @type {Record<string,unknown>} */ (generateManifest(existingManifest, '1.0.1', 'Jozo132/wicro', 'llvm-wasm-v1.0.1', local, 'gzip', root));
  const artifacts = /** @type {Record<string,Record<string,unknown>>} */ (manifest.artifacts);
  assert.equal(artifacts.clang.compression, 'gzip');
  assert.equal(artifacts.clang.distributionFilename, 'llvm.wasm.gz');
  assert.equal(artifacts.ld.distributionFilename, 'ld.wasm.gz');
  assert.ok(Number(artifacts.clang.size) < Number(artifacts.clang.uncompressedSize));
    assert.match(generateSha256Sums(manifest), /llvm\.wasm\.gz/);
    assert.match(generateSha256Sums(manifest), /  llvm\.wasm$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release integration test is explicitly gated and never publishes accidentally', async (context) => {
  if (process.env.WICRO_LLVM_RELEASE_INTEGRATION !== 'I-AUTHORIZE-Wicro-LLVM-WASM-RELEASE') {
    context.skip('Set WICRO_LLVM_RELEASE_INTEGRATION to the explicit authorization phrase to run real GitHub operations');
    return;
  }
  assert.fail('Real GitHub release integration must be invoked by the maintainers intentionally; this task does not authorize one.');
});
