#!/usr/bin/env bash
set -euo pipefail

OUTPUT="${1:-$(cd "$(dirname "$0")" && pwd)/cache}"
JOBS="${JOBS:-24}"
LLVM_TARGETS="${LLVM_TARGETS:-ARM;AVR;RISCV}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/wicro-llvm-wasm.XXXXXX")"

cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$OUTPUT"
git clone --depth 1 https://github.com/lemio/esp-wasm.git "$WORK/esp-wasm"
cd "$WORK/esp-wasm/toolchain"
mkdir -p out/wasi-sdk

# Keep this wrapper reproducible across upstream recipe updates.
sed -i 's/-D_WASI_EMULATED_PROCESS_CLOCKS")/-D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID")/' build-llvm.sh
sed -i 's|-lwasi-emulated-process-clocks -Wl,--max-memory|-lwasi-emulated-process-clocks -lwasi-emulated-getpid -Wl,--initial-memory=33554432 -Wl,--extra-features=bulk-memory -Wl,--extra-features=sign-ext -Wl,--extra-features=mutable-globals -Wl,--extra-features=multivalue -Wl,--extra-features=reference-types -Wl,--extra-features=nontrapping-fptoint -Wl,--max-memory|' build-llvm.sh
sed -i 's|-mcpu=lime1 \\${WASI_EMU}|-mcpu=lime1 -mbulk-memory -msign-ext -mmutable-globals -mnontrapping-fptoint -mmultivalue -mreference-types \\${WASI_EMU}|g' build-llvm.sh
sed -i '/# Every tool that would otherwise end up in the multicall binary/i rm -rf "$PWD/wasi"\n' build-llvm.sh
sed -i '/enable-call-indirect-overlong/d' build-llvm.sh

curl -fL --retry 3 \
  https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sdk-34.0-x86_64-linux.tar.gz \
  | tar xz --strip-components=1 -C out/wasi-sdk

LLVM_TARGETS="$LLVM_TARGETS" JOBS="$JOBS" \
  ./build-llvm.sh "$OUTPUT"
