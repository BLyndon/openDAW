#!/usr/bin/env bash
# Can each option link into a no_std wasm module that brings its own allocator and panic handler, as the
# engine does? Builds every no_std stub and prints a Markdown table; a failing build is a result, not an
# error of this script. Run from anywhere: size/nostd-check.sh
set -u
cd "$(dirname "$0")"
TARGET=wasm32-unknown-unknown
STUBS="empty analyser rfft signalsmith realfft"

echo "| Stub | no_std link with own allocator and panic handler | First error |"
echo "|---|---|---|"
for stub in $STUBS; do
  log=$(cargo build --release --target "$TARGET" -p "size-$stub" 2>&1)
  if [ $? -eq 0 ]; then
    echo "| $stub | yes | – |"
  else
    # Escape table pipes; turn the compiler's backticks into quotes so the Markdown code span holds.
    error=$(echo "$log" | grep -m1 '^error' | sed "s/|/\\\\|/g; s/\`/'/g")
    echo "| $stub | **no** | \`$error\` |"
  fi
done
