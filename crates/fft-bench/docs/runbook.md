# Runbook

A complete measurement run, start to finish: the numbers that go into the evaluation. Each step lists the
command, the expected result when everything is in order (**Expected**), and what to do if the result
differs (**If not**). Background on the method is in the
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
| Chrome, Firefox, Safari | current releases, for step 7 | — |

Time for a full run: about 25 minutes, most of it the native benchmarks in step 4, plus a few minutes
per browser in step 7.

All commands run from `crates/fft-bench` unless stated. Results go to a folder outside the crate, here
`$RESULTS`, for example:

```sh
RESULTS=../../analysis/results/$(date +%Y-%m-%d)
mkdir -p "$RESULTS"
```

## 1. Prepare

**Purpose:** make the results attributable and the timings undisturbed.

1. **Clean tree.** `git status` shows nothing to commit, so the hash in every result identifies the code.
   A result with `-dirty` in its environment header is not attributable.
2. **Quiet machine.** Quit every application the run does not need (browsers, IDE indexing, sync and
   backup clients, chat, video calls). Mains power, Low Power Mode off.
3. **Build first, then wait.** Builds heat the machine. Build everything once, then give it a minute:

   ```sh
   cargo build --release --examples
   cargo bench --bench fft --no-run
   cargo build --release --target wasm32-unknown-unknown
   ```

   Examples and benches build separately: the release profile aborts on panic, Criterion's harness
   needs unwinding, and one build of both links the bench against the wrong copy of the library.

## 2. Correctness

**Purpose:** pass/fail. Does every option meet its gates, and does the harness itself work? Nothing is
measured until this passes.

```sh
cargo test
node --test *.test.mjs web/*.test.mjs
```

**Expected:**

- Every test passes; none fails.

**If not:** stop. A failing faithful-copy test means a copy no longer matches its original; a failing
accuracy or allocation test means an option breaks a gate. Fix first, then start again at step 1.

## 3. Accuracy report

**Purpose:** numbers, not pass/fail. How far each option's output is from the exact result and from the
analyser, per signal and size.

```sh
cargo run --release --example report > "$RESULTS/accuracy.md"
```

**Expected:**

- Finishes in a few seconds.
- An environment table on top, then five tables.
- Relative RMS around 1e-7 for every option.
- Round-trip error below 1e-5.
- Analyser contract deviation below 1e-5.
- `0.0e0` means the deviation is exactly zero: the option's output is bit-identical to the reference.
  In the analyser contract table this is expected for the `analyser` column (compared with itself), for
  options that compute the same radix-2 in the same order (`signalsmith`, `reverted`), and for the
  impulse and denormal rows. Denormal input squares to zero in every option, so that row tells nothing
  about accuracy.

## 4. Native benchmarks

**Purpose:** time per call on this machine's CPU, for development and copy fidelity, not for the decision.

Development numbers only (natively `realfft` uses NEON or AVX, not SIMD128), but they show the scalar
options and the copy fidelity on the same machine.

```sh
cargo bench --bench fft -- --measurement-time 10 --warm-up-time 3 > "$RESULTS/native.txt"
```

**Expected:**

- An environment table on top.
- `analyser_fidelity/original` and `analyser_fidelity/copy` within a few percent of each other.
- Every `time:` interval within ±5 % of its middle value.

**If not:**

- **Fidelity gap:** run `cargo bench --bench fft -- --measurement-time 5 --warm-up-time 2 analyser_fidelity`
  on its own, three times. If the gap persists in isolated runs, the analyser baseline is not faithful in
  speed; note it next to every analyser number.
- **Intervals above ±5 %:** rerun only those points with a filter, for example
  `cargo bench --bench fft -- --measurement-time 10 'forward/analyser/1024'`, on a quieter machine.

## 5. Wasm in Node, with the render budget

**Purpose:** time per call as wasm with SIMD128, and what share of the render quantum each consumer would use.

```sh
node run.mjs > "$RESULTS/node.md"
```

**Expected:**

- Finishes in about 30 seconds.
- An environment table: Node and V8 versions, module hash, git hash, timer cost.
- Throughput tables, single-call tables, the step table for `signalsmith`, the render budget per consumer.
- No ⚠ in the tables. The one in the legend line does not count.

**If not:** a ⚠ marks a point whose confidence interval stayed above 5 % after 120 batches. Rerun it
alone, for example `node run.mjs --sizes 4096 --options signalsmith`, on a quieter machine.

These numbers are preliminary: Node did not show the slowdown that led to the revert of the earlier
SIMD pass. The numbers that count come from step 7.

## 6. Binary size and no_std

**Purpose:** what each option adds to the engine's wasm binary, and whether it can link into the
`no_std` engine at all.

```sh
size/size.sh > "$RESULTS/size.md"
size/nostd-check.sh > "$RESULTS/nostd.md"
```

**Expected:**

- Both scripts print a Markdown table, together in about 30 seconds.
- `nostd-check.sh` shows `yes` for `empty`, `analyser`, `rfft` and `signalsmith`.
- `nostd-check.sh` shows **no** for `realfft`, with a duplicate `panic_impl`. This is a finding, not a
  failure: `std` brings a panic handler that collides with the engine's.

**If not:** `wasm-opt not found` → install binaryen. A stub other than `realfft` failing `no_std` means a
dependency started to need `std`; read its first error line in the table.

## 7. Browsers

**Purpose:** the timings that count, in the runtimes the engine actually runs in.

```sh
node web/serve.mjs
```

Open `http://127.0.0.1:8080/` in Chrome, Firefox and Safari, one browser at a time, with the tab in front
and nothing else running. The page leads through seven steps; each one unlocks the next. Run Safari by hand:
Playwright's WebKit is not Safari.

**Expected:**

- Step 1 ✔: cross-origin isolated, timer tick ≤ 20 µs (Chrome shows 5 µs), SIMD128 available.
- Step 2 ✔: every registered option listed; the module hash equals the `module` line in `node.md`.
- Steps 3–5 ✔, or ⚠ for single points only; rerun those with their rerun button.
- No "tab was hidden" remark in any step.
- Step 7 downloads `browser-<browser>-<major version>.md`. Move it to `$RESULTS`.
- A few minutes per browser, most of it in step 5.

**If not:**

- **Step 1 ✘** names the cause: not isolated (the page was not served by `web/serve.mjs`), a coarse
  timer, or no SIMD128. Nothing can be measured until it passes.
- **"module older than its sources"** in step 2: rebuild the wasm module, reload the page.
- **"tab was hidden"**: the browser throttled the page while it was in the background, and timings run
  2–3× slow. Run the step again with the tab in front.
- **Many ⚠ points**: the machine is busy; step 1 of this runbook again.

The page times in a Worker, not in an AudioWorklet: a worklet has no high-resolution clock. The numbers
are the browser's wasm engine on a background thread, not the audio thread itself.

## 8. Wrap up

**Purpose:** make sure the result files belong together and are kept.

1. **Check the headers.** Every result file starts with an environment table. The git hash must be the
   same everywhere and without `-dirty`.
2. **Compare like with like.** Only compare numbers from the same run and the same platform.
3. **Keep the raw files.** `$RESULTS` holds `accuracy.md`, `native.txt`, `node.md`, `size.md`,
   `nostd.md` and one `browser-*.md` per browser. Commit them with the analysis, not with the harness.
4. **Note deviations.** Anything that did not look as described above goes next to the numbers.

## After adding an option

When the prototype or another kernel joins the registry (see
[Adding an option](workflow.md#adding-an-option)):

| Rerun | Why |
|---|---|
| Steps 2 and 3 | gates and accuracy for the new option |
| Step 5 | its wasm timings and its row in the render budget |
| Step 7 | its timings in the browsers; the page lists every registered option |
| Step 6, after adding a stub to `size/stubs/` and to both scripts | its size and whether it links `no_std` |
| Step 4 | only if its native numbers matter |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `target may not be installed` | wasm target missing | `rustup target add wasm32-unknown-unknown` |
| wasm build fails on SIMD intrinsics | a `RUSTFLAGS` variable replaces `.cargo/config.toml` (`+simd128`) | `unset RUSTFLAGS` |
| `run.mjs` fails to instantiate the module | module missing or stale | rebuild with `cargo build --release --target wasm32-unknown-unknown` |
| `requires panic strategy 'abort'` and an output filename collision warning | examples and benches built in one `cargo build` | build them separately, as in step 1 |
| `could not find Cargo.toml` | shell is not in `crates/fft-bench` | `cd crates/fft-bench` |
| First `cargo bench` takes minutes | Criterion and its dependencies are downloaded and built once | wait; later runs start immediately |
| Numbers jump between runs | busy machine | step 1 again; compare only numbers from one run |
| Browser page: step 1 ✘ "not cross-origin isolated" | page opened through another server or from a file | `node web/serve.mjs`, open the URL it prints |
| Browser page: step 2 ⚠ "module older than its sources" | Rust sources changed after the last wasm build | `cargo build --release --target wasm32-unknown-unknown`, reload |
| Browser page: port 8080 in use | another dev server runs there | `node web/serve.mjs --port 8090` |
| `wasm-opt` rejects a module | its feature flags differ from the build | keep `size.sh`'s feature list equal to `build-wasm.sh` |
