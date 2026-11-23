#!/usr/bin/env bash
set -euo pipefail

OUTPUT="${1:-$(cd "$(dirname "$0")" && pwd)/cache}"
JOBS="${JOBS:-24}"
LLVM_TARGETS="${LLVM_TARGETS:-ARM;AVR;RISCV}"
ESP_WASM_REF="${ESP_WASM_REF:-dceb9e3126898359bff8ab9e44bec5b65d87b5d3}"
LLVM_REF="${LLVM_REF:-esp-20.1.1_20250829}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/wicro-llvm-wasm.XXXXXX")"

cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$OUTPUT"
git clone https://github.com/lemio/esp-wasm.git "$WORK/esp-wasm"
git -C "$WORK/esp-wasm" checkout "$ESP_WASM_REF"
cd "$WORK/esp-wasm/toolchain"
mkdir -p out/wasi-sdk

# Keep this wrapper reproducible across upstream recipe updates.
sed -i 's/-D_WASI_EMULATED_PROCESS_CLOCKS")/-D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID")/' build-llvm.sh
sed -i 's|-lwasi-emulated-process-clocks -Wl,--max-memory|-lwasi-emulated-process-clocks -lwasi-emulated-getpid -Wl,--initial-memory=33554432 -Wl,--extra-features=bulk-memory -Wl,--extra-features=sign-ext -Wl,--extra-features=mutable-globals -Wl,--extra-features=multivalue -Wl,--extra-features=reference-types -Wl,--extra-features=nontrapping-fptoint -Wl,--max-memory|' build-llvm.sh
sed -i 's|-mcpu=lime1 \\${WASI_EMU}|-mcpu=lime1 -mbulk-memory -msign-ext -mmutable-globals -mnontrapping-fptoint -mmultivalue -mreference-types \\${WASI_EMU}|g' build-llvm.sh
sed -i '/# Every tool that would otherwise end up in the multicall binary/i rm -rf "$PWD/wasi"\n' build-llvm.sh
sed -i '/enable-call-indirect-overlong/d' build-llvm.sh
sed -i 's|-DLLVM_ENABLE_PROJECTS="clang;lld"|-DLLVM_ENABLE_PROJECTS="clang;lld;clang-tools-extra"|' build-llvm.sh
sed -i 's|-DCLANG_LINKS_TO_CREATE="clang;clang++"|-DCLANG_LINKS_TO_CREATE="clang;clang++;clangd;clang-tidy;clang-format"|' build-llvm.sh
sed -i '/^TOOLS_OFF=()/,/^done$/c\TOOLS_OFF=()' build-llvm.sh
sed -i 's/ninja -j"$JOBS" -k "${KEEP_GOING:-1}" -C wasi llvm-driver clang-resource-headers/ninja -j"$JOBS" -k "${KEEP_GOING:-1}" -C wasi llvm-driver clangd clang-tidy clang-format llvm-ar llvm-objcopy llvm-objdump llvm-size llvm-nm llvm-readelf clang-resource-headers/' build-llvm.sh

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    curl -fL --retry 3 \
      https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sdk-34.0-x86_64-windows.tar.gz \
      | tar xz --strip-components=1 -C out/wasi-sdk
    ;;
  Darwin*)
    uname_output="$(uname -m)"
    if [ "$uname_output" = "arm64" ]; then
      wasi_asset="wasi-sdk-34.0-arm64-macos.tar.gz"
    else
      wasi_asset="wasi-sdk-34.0-x86_64-macos.tar.gz"
    fi
    curl -fL --retry 3 \
      "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/$wasi_asset" \
      | tar xz --strip-components=1 -C out/wasi-sdk
    ;;
  *)
    curl -fL --retry 3 \
      https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sdk-34.0-x86_64-linux.tar.gz \
      | tar xz --strip-components=1 -C out/wasi-sdk
    ;;
esac

LLVM_TARGETS="$LLVM_TARGETS" LLVM_REF="$LLVM_REF" JOBS="$JOBS" \
  CC="${HOST_CC:-cc}" CXX="${HOST_CXX:-c++}" WASI_SDK="$PWD/out/wasi-sdk" \
  ./build-llvm.sh "$OUTPUT"
