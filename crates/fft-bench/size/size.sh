#!/usr/bin/env bash
# Wasm binary size per option, built like the engine: +simd128, opt-level 3, LTO, abort, stripped, then
# wasm-opt -Oz with the feature set of packages/studio/core-wasm/build-wasm.sh, then gzip -9. The delta is
# taken against the matching empty stub, so it is what the option adds. Also counts the crates each stub
# pulls in. Prints Markdown. Run from anywhere: size/size.sh
set -eu
cd "$(dirname "$0")"
TARGET=wasm32-unknown-unknown
OUT="target/$TARGET/release"
FEATURES="--enable-bulk-memory --enable-mutable-globals --enable-simd --enable-sign-ext --enable-nontrapping-float-to-int --enable-multivalue --enable-reference-types"
# stub:baseline. realfft is measured as a std module, since it cannot link no_std (see nostd-check.sh).
STUBS="empty:empty analyser:empty rfft:empty signalsmith:empty empty-std:empty-std realfft-std:empty-std"

command -v wasm-opt >/dev/null || { echo "wasm-opt not found (brew install binaryen)" >&2; exit 1; }

gzipped() { gzip -9 -c "$1" | wc -c | tr -d ' '; }

declare -A RAW OPTIMISED GZIPPED
for entry in $STUBS; do
  stub=${entry%%:*}
  cargo build --release --target "$TARGET" -p "size-$stub" 2>/dev/null
  module="$OUT/size_${stub//-/_}.wasm"
  wasm-opt -Oz $FEATURES "$module" -o "$module.opt"
  RAW[$stub]=$(wc -c < "$module" | tr -d ' ')
  OPTIMISED[$stub]=$(wc -c < "$module.opt" | tr -d ' ')
  GZIPPED[$stub]=$(gzipped "$module.opt")
done

echo "| Stub | Baseline | Raw bytes | After wasm-opt | gzip -9 | Added by the option (gzip) | Crates pulled in |"
echo "|---|---|---|---|---|---|---|"
for entry in $STUBS; do
  stub=${entry%%:*}
  baseline=${entry##*:}
  crates=$(cargo tree -p "size-$stub" -e normal --prefix none --target "$TARGET" | sed 's/ (\*)$//' | sort -u | wc -l | tr -d ' ')
  added=$([ "$stub" = "$baseline" ] && echo "–" || echo $(( GZIPPED[$stub] - GZIPPED[$baseline] )))
  echo "| $stub | $baseline | ${RAW[$stub]} | ${OPTIMISED[$stub]} | ${GZIPPED[$stub]} | $added | $crates |"
done
