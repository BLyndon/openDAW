# Plan: FFT timings on the audio thread (AudioWorklet)

Follow-up to `plans/simd-fft-harness.md`. The browser page times every option in a Worker
(`crates/fft-bench/docs/architecture.md`, "Why a Worker, not an AudioWorklet"). This plan adds the
same measurement inside an AudioWorklet, the thread the engine actually renders on. It does not
change production code.

> AI assistance: this work is done with Claude Code. All code is reviewed and understood line by
> line by the contributor before it is submitted.

## Goal

Answer one question with measured numbers:

> Does an FFT option cost the same on the audio render thread as in a Worker, and does its ranking
> (`realfft` vs. `simd` vs. `simd-o1o4` vs. `rfft`) hold there?

Secondary checks on the same thread:

- the module loads and instantiates in `AudioWorkletGlobalScope`, SIMD128 is available;
- the wasm output has the native bits (as `bits.mjs` checks in Node);
- the time per call fits the render quantum with headroom (real-time tails, underruns).

If the worklet numbers match the Worker within the noise, the result is one paragraph in the
architecture doc and the Worker page stays the measurement of record.

## Precondition

Ask the maintainer first (part of the harness issue): is an audio-thread measurement wanted, or is
the Worker enough? The architecture doc already lists this as an open question. Do not start
step 2 before an answer.

## Scope

### In

- A third browser page `web/worklet.html` with its own processor module
- Offline (`OfflineAudioContext`) and real-time (`AudioContext`) runs
- Chrome, Firefox, Safari (Safari by hand)
- Comparison table worklet vs. Worker per option and size, in the page report

### Out

- Any change to the engine worklet, `EngineWorklet.ts` or `HRClockWorker.ts`
- New Rust options or kernel changes
- Hann helpers (separate gap from the future-plan review, own task)

## Approach

### 1. Clock

`AudioWorkletGlobalScope` has no `performance` (Chrome 155, Firefox 157; see
`plans/dsp-load-measurement.md`). Use the approach openDAW already ships in
`packages/studio/core/src/HRClockWorker.ts`:

- a Worker spins `performance.now()` into a `Float64Array` on a `SharedArrayBuffer`;
- the processor reads it before and after the measured work, no atomics;
- a block whose two reads are equal is dropped (the clock worker was descheduled);
- below 4 logical cores the page refuses to run and says why.

The harness copies the five-line worker body instead of importing from `studio/core`: the crate is
standalone and must stay free of the app's build. The page is cross-origin isolated already
(`serve.mjs` sends COOP/COEP), so the clock has the browser's fine tick (Chrome 5 µs, Firefox 20 µs).

Clock overhead: both batches of a pair read the clock twice, so its cost cancels in the difference;
no separate overhead mode is needed. Drop rule as implemented: a kernel batch whose two reads are equal
is dropped; a batch without the kernel may fit in one tick, so equal reads are valid there.

### 2. Loading the module into the worklet

- Main thread fetches `fft_bench.wasm` and compiles it to a `WebAssembly.Module`.
- The module is sent in `processorOptions`; the processor calls `new WebAssembly.Instance(module, {})`
  in its constructor. `src/wasm.rs` is import-free, so no glue is needed.
- Fallback if a browser cannot post a `Module` to a worklet (check Safari): post the bytes and
  compile in the worklet.
- SIMD128 probe and the option list (`option_count`, `option_name_*`, `option_is_complex`) run in
  the worklet and are reported back, so the page shows what the audio thread sees.

### 3. Measurement in `process()`

Reuse the existing exports; no new Rust code is expected:

- `setup(option, n)` once per option and size, outside any measured block;
- per block: read clock, `run_forward(count, 1)` (or `run_inverse`), read clock;
- paired blocks with `with_kernel = 0` give the preparation cost, as the Worker page does
  (difference = kernel time, divided by `count`);
- `count` is calibrated per option and size so one block's work is about 10–50% of the quantum
  (2.67 ms at 48 kHz), never above;
- per-block durations go into a preallocated record buffer on a `SharedArrayBuffer` (one slot per
  measured block, NaN = dropped); the main thread reads it after the run, the processor never allocates
  or posts per block;
- options and sizes are interleaved in rounds, not run back to back, so CPU frequency drift spreads
  over all of them.

Sizes: 256, 1024, 4096, 16384 (per-call overhead, the two decision sizes, the largest).

### 4. Correctness on the audio thread

Before the timing runs, in an `OfflineAudioContext`: `setup_signal` for every signal, option and size,
and an FNV-1a hash of input, `re`, `im` and `output` posted back. The page compares it with the same
hashes from the Worker. Worker against native is covered by `node bits.mjs` (V8); in Firefox and
Safari the page checks worklet = Worker only.

### 5. Runs

- **Offline:** `OfflineAudioContext`, one processor, fixed number of blocks. Gives pure compute time
  on the render thread without real-time pressure.
- **Real-time:** `AudioContext` with `latencyHint: "interactive"`, 48 kHz, about 15 s per mode.
  Reports median, p99, p99.9 per block and, in Chrome, underruns from `playbackStats`.
- Per browser: Chrome, Firefox (page, scripted or by hand), Safari by hand. Record the environment
  as the other pages do (`/environment`, browser and version, core count).

### 6. Evaluation

- Table per option and size: Worker time, worklet offline, worklet real-time median and p99,
  ratio worklet ÷ Worker.
- Same ranking check as the decision page: `realfft` ÷ own kernel on the audio thread.
- Criterion for "no difference": ratio within the confidence interval of both measurements
  (target ≤ 5%, see benchmark hygiene in `CLAUDE.local.md`).
- If the ratio differs: add a worklet row to `overview.mjs` and `analysis/README.md`; otherwise one
  paragraph in `docs/architecture.md`.

## Files

| File | Change |
|---|---|
| `crates/fft-bench/web/worklet.html` | new page: start, progress, table, report |
| `crates/fft-bench/web/worklet.mjs` | main thread: clock worker, module transfer, runs, evaluation, report |
| `crates/fft-bench/web/worklet-copy.mjs` | the page's text and steps |
| `crates/fft-bench/web/worklet-logic.mjs` | schedule, record layout, calibration, drop rule, digests (shared) |
| `crates/fft-bench/web/worklet-processor.mjs` | `AudioWorkletProcessor`: instantiate, calibrate, measure, record buffer |
| `crates/fft-bench/web/clock.mjs` | spinning clock worker (copy of the `HRClockWorker` body) |
| `crates/fft-bench/web/worklet*.test.mjs` | unit tests for schedule, record layout, drop rule, calibration, evaluation, report |
| `crates/fft-bench/web/worker.mjs` | `digests` request for the bits comparison |
| `crates/fft-bench/web/serve.mjs` | route `/worklet` |
| `crates/fft-bench/web/index.html` | link to the third page |
| `crates/fft-bench/docs/*.md`, `README.md` | runbook step, architecture section, testing concept column |
| `analysis/README.md` | results and status |

`serve.mjs` serves every non-test file in `web/`; only the page route `/worklet` is new.

## Steps

1. Maintainer answer on whether the audio-thread measurement is wanted (precondition).
2. Clock worker + processor skeleton: load the module, SIMD probe, option list shown on the page.
3. Ring buffer and dropped-block rule, with unit tests on the decoding side.
4. Calibration of `count` and the paired with/without-kernel blocks.
5. Offline run in Chrome; compare with the Worker page on the same machine.
6. Real-time run, `playbackStats` in Chrome.
7. Bits check on the audio thread.
8. Firefox and Safari runs.
9. Evaluation table in the page report, docs, `analysis/README.md`.
10. Separate PR after the browser-page PR.

## Risks

- **Spinning clock competes with the audio thread** (Firefox offline +18 µs per block in
  `plans/dsp-load-measurement.md`). Mitigation: clock-overhead mode, and the same clock is running
  in every mode, so it cancels in the comparison between options.
- **Safari:** may not support posting a `Module` to the worklet or may give a coarser tick.
  Fallback: bytes; report the tick.
- **Real-time variance** on a loaded machine. Mitigation: interleaved rounds, quiet machine,
  report p99, not only the median.
- **Calibration overshoot** causes underruns that distort the run. Mitigation: calibrate offline
  first, cap at 50% of the quantum.

## Open questions for the maintainer

- Is an audio-thread measurement wanted, or is the Worker page enough?
- Should real-time underruns count as a gate, or only as information?
- Should the worklet page live in the repository or stay local?
