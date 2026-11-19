#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUTPUT="${1:-$HERE/cache}"
ESP_WASM_REF="${ESP_WASM_REF:-dceb9e3126898359bff8ab9e44bec5b65d87b5d3}"
LLVM_REF="${LLVM_REF:-esp-20.1.1_20250829}"
JOBS="${JOBS:-24}"
LLVM_TARGETS="${LLVM_TARGETS:-ARM;AVR;RISCV}"

mkdir -p "$OUTPUT"
ESP_WASM_REF="$ESP_WASM_REF" LLVM_REF="$LLVM_REF" JOBS="$JOBS" LLVM_TARGETS="$LLVM_TARGETS" \
  "$HERE/build-common.sh" "$OUTPUT"

node - <<'NODE' "$OUTPUT"
import { readdir, readFile, writeFile } from 'node:fs/promises';

const output = process.argv[2];
const manifestPath = `${output}/../manifest.json`;
const names = await readdir(output);
const desired = ['clangd.wasm', 'clang-tidy.wasm', 'clang-format.wasm', 'llvm-ar.wasm', 'llvm-objcopy.wasm', 'llvm-objdump.wasm', 'llvm-size.wasm', 'llvm-nm.wasm', 'llvm-readelf.wasm'];
const available = ['clang', 'ld'].filter((name) => names.includes(name === 'clang' ? 'llvm.wasm' : 'ld.wasm'));

let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch {
  manifest = {};
}
manifest.entryPoints = {
  ...(manifest.entryPoints ?? {}),
  available,
  separateRequired: desired.filter((name) => !names.includes(name)),
  lastBuild: new Date().toISOString()
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(JSON.stringify({ availableEntryPoints: available, separateArtifacts: Object.fromEntries(desired.map((name) => [name, names.includes(name) ? 'present' : 'missing'])) }, null, 2));
NODE
