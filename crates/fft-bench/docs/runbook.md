# Runbook

A complete measurement run, start to finish: the numbers that go into the evaluation. Each step lists the
command, what a good result looks like, and what to do if it is not. Background on the method is in the
[workflow](workflow.md) and the [testing concept](testing-concept.md).

## Contents

- [Before you start](#before-you-start)
- [1. Prepare](#1-prepare)
- [2. Correctness](#2-correctness)
- [3. Accuracy report](#3-accuracy-report)
- [4. Native benchmarks](#4-native-benchmarks)
- [5. Wasm in Node, with the render budget](#5-wasm-in-node-with-the-render-budget)
- [6. Binary size and no_std](#6-binary-size-and-no_std)
- [7. Browsers](#7-browsers)
- [8. Wrap up](#8-wrap-up)
- [After adding an option](#after-adding-an-option)
- [Troubleshooting](#troubleshooting)

## Before you start

| Needed | Check | Install |
|---|---|---|
| Rust stable with the wasm target | `rustup target list --installed` shows `wasm32-unknown-unknown` | `rustup target add wasm32-unknown-unknown` |
| Node 24 or newer | `node --version` | — |
| binaryen (`wasm-opt`) | `wasm-opt --version` | `brew install binaryen` |
| gzip, git | present on macOS and Linux | — |

Time for a full run: about 25 minutes, most of it the native benchmarks in step 4.

All commands run from `crates/fft-bench` unless stated. Results go to a folder outside the crate, here
`$RESULTS`, for example:

```sh
RESULTS=../../analysis/results/$(date +%Y-%m-%d)
mkdir -p "$RESULTS"
```

## 1. Prepare

1. **Clean tree.** `git status` shows nothing to commit, so the hash in every result identifies the code.
   A result with `-dirty` in its environment header is not attributable.
2. **Quiet machine.** Quit every application the run does not need (browsers, IDE indexing, sync and
   backup clients, chat, video calls). Mains power, Low Power Mode off.
3. **Build first, then wait.** Builds heat the machine. Build everything once, then give it a minute:

   ```sh
   cargo build --release --examples --benches
   cargo build --release --target wasm32-unknown-unknown
   ```

## 2. Correctness

Nothing is measured until this passes.

```sh
cargo test
node --test budget.test.mjs
```

**Good:** `tests/accuracy.rs` 8 passed, `tests/allocation.rs` 2 passed, `tests/faithful_copy.rs` 8 passed;
budget model 5 passed, 0 failed.

**If not:** stop. A failing faithful-copy test means a copy no longer matches its original; a failing
accuracy or allocation test means an option breaks a gate. Fix first, then start again at step 1.

## 3. Accuracy report

```sh
cargo run --release --example report > "$RESULTS/accuracy.md"
```

**Good:** an environment table on top, then five tables. Relative RMS around 1e-7 for every option,
round trip below 1e-5, analyser contract below 1e-5. Takes a few seconds.

## 4. Native benchmarks

Development numbers only (natively `realfft` uses NEON or AVX, not SIMD128), but they show the scalar
options and the copy fidelity on the same machine.

```sh
cargo bench --bench fft -- --measurement-time 10 --warm-up-time 3 > "$RESULTS/native.txt"
```

**Good:** an environment table on top; `analyser_fidelity/original` and `analyser_fidelity/copy` within
a few percent of each other; every `time:` interval within ±5 % of its middle value.

**If not:**

- **Fidelity gap:** run `cargo bench --bench fft -- --measurement-time 5 --warm-up-time 2 analyser_fidelity`
  on its own, three times. If the gap persists in isolated runs, the analyser baseline is not faithful in
  speed; note it next to every analyser number.
- **Intervals above ±5 %:** rerun only those points with a filter, for example
  `cargo bench --bench fft -- --measurement-time 10 'forward/analyser/1024'`, on a quieter machine.

## 5. Wasm in Node, with the render budget

```sh
node run.mjs > "$RESULTS/node.md"
```

**Good:** about 30 seconds. An environment table (Node and V8 versions, module hash, git hash, timer
cost), throughput tables, single-call tables, the step table for `signalsmith`, and the render budget per
consumer. No ⚠ in the tables (the one in the legend line does not count).

**If not:** a ⚠ marks a point whose confidence interval stayed above 5 % after 120 batches. Rerun it
alone, for example `node run.mjs --sizes 4096 --options signalsmith`, on a quieter machine.

These numbers are preliminary: Node did not show the slowdown that led to the revert of the earlier
SIMD pass. The numbers that count come from step 7.

## 6. Binary size and no_std

```sh
size/size.sh > "$RESULTS/size.md"
size/nostd-check.sh > "$RESULTS/nostd.md"
```

**Good:** both print a Markdown table, together in about 30 seconds. `nostd-check.sh` shows `yes` for
`empty`, `analyser`, `rfft` and `signalsmith`; `realfft` shows **no** with a duplicate `panic_impl`.
That is the expected result: `std` brings a panic handler that collides with the engine's.

**If not:** `wasm-opt not found` → install binaryen. A stub other than `realfft` failing `no_std` means a
dependency started to need `std`; read its first error line in the table.

## 7. Browsers

Not available yet: the AudioWorklet page that runs the same wasm module and `budget.mjs` in Chrome,
Firefox and Safari is planned as a separate PR. Until then, steps 4 and 5 are the only timings, and they
are preliminary. When it exists: run Safari by hand (Playwright's WebKit is not Safari), and record
browser name and version with every result.

## 8. Wrap up

1. **Check the headers.** Every result file starts with an environment table. The git hash must be the
   same everywhere and without `-dirty`.
2. **Compare like with like.** Only compare numbers from the same run and the same platform.
3. **Keep the raw files.** `$RESULTS` holds `accuracy.md`, `native.txt`, `node.md`, `size.md` and
   `nostd.md`. Commit them with the analysis, not with the harness.
4. **Note deviations.** Anything that did not look as described above goes next to the numbers.

## After adding an option

When the prototype or another kernel joins the registry (see
[Adding an option](workflow.md#adding-an-option)):

| Rerun | Why |
|---|---|
| Steps 2 and 3 | gates and accuracy for the new option |
| Step 5 | its wasm timings and its row in the render budget |
| Step 6, after adding a stub to `size/stubs/` and to both scripts | its size and whether it links `no_std` |
| Step 4 | only if its native numbers matter |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `target may not be installed` | wasm target missing | `rustup target add wasm32-unknown-unknown` |
| wasm build fails on SIMD intrinsics | a `RUSTFLAGS` variable replaces `.cargo/config.toml` (`+simd128`) | `unset RUSTFLAGS` |
| `run.mjs` fails to instantiate the module | module missing or stale | rebuild with `cargo build --release --target wasm32-unknown-unknown` |
| First `cargo bench` takes minutes | Criterion and its dependencies are downloaded and built once | wait; later runs start immediately |
| Numbers jump between runs | busy machine | step 1 again; compare only numbers from one run |
| `wasm-opt` rejects a module | its feature flags differ from the build | keep `size.sh`'s feature list equal to `build-wasm.sh` |
