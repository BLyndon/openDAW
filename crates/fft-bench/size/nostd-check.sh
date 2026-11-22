#!/usr/bin/env bash
# Can each option link into a no_std wasm module that brings its own allocator and panic handler, as the
# engine does? Builds every no_std stub and prints a Markdown table; a failing build is a result, not an
# error of this script. Prints Markdown, or JSON with --json. Run from anywhere: size/nostd-check.sh [--json]
set -u
cd "$(dirname "$0")"
TARGET=wasm32-unknown-unknown
STUBS="empty analyser rfft signalsmith simd realfft"

json=$([ "${1:-}" = "--json" ] && echo 1 || echo 0)
separator=""
[ "$json" = 1 ] && printf '{' || { echo "| Stub | no_std link with own allocator and panic handler | First error |"; echo "|---|---|---|"; }
for stub in $STUBS; do
  log=$(cargo build --release --target "$TARGET" -p "size-$stub" 2>&1)
  status=$?
  error=$(echo "$log" | grep -m1 '^error')
  if [ "$json" = 1 ]; then
    # JSON string: escape backslashes and quotes.
    quoted=$([ $status -eq 0 ] && echo null || echo "\"$(echo "$error" | sed 's/\\/\\\\/g; s/"/\\"/g')\"")
    printf '%s"%s": {"links": %s, "error": %s}' "$separator" "$stub" "$([ $status -eq 0 ] && echo true || echo false)" "$quoted"
    separator=", "
  elif [ $status -eq 0 ]; then
    echo "| $stub | yes | – |"
  else
    # Escape table pipes; turn the compiler's backticks into quotes so the Markdown code span holds.
    error=$(echo "$error" | sed "s/|/\\\\|/g; s/\`/'/g")
    echo "| $stub | **no** | \`$error\` |"
  fi
done
[ "$json" = 1 ] && echo '}'
exit 0
