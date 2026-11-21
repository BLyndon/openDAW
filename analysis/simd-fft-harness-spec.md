# SIMD FFT: harness spec

Spec for Day 1 step 2 of `plans/simd-fft-harness.md`. Builds on `analysis/simd-fft-baseline.md`.
No production code changes; the only edits outside the new crate are one `exclude` entry in
`crates/Cargo.toml` and one line in `crates/.gitignore`.

## Questions

1. **How much faster can the FFT get with SIMD128?** (unchanged, the main question)
2. **Why would it work this time?** A SIMD FFT was tried and reverted (baseline analysis, section 6).
3. **Is it worth it?** Savings as % of the render budget per consumer, not only as a speed factor.

## Deviations from the plan

| Plan                             | Spec                                                                | Why                                              |
|----------------------------------|---------------------------------------------------------------------|--------------------------------------------------|
| One baseline: analyser radix-2   | Three: analyser FFT, `dsp::rfft`, `signalsmith::fft`                | All three run on the render path                 |
| N = 256–8192                     | N = 256–16384                                                       | Convolver runs `dsp::rfft` at N = 16384          |
| "≥ 4× vs. current scalar"        | Reported against each baseline                                      | Baselines differ by ≈ 2× before SIMD             |
| Rel. RMS "≤ 2× current"          | ≤ 2× `dsp::rfft` (all N); ≤ 2× analyser copy (contract path)        | "current" is ambiguous with several baselines    |
| Browser page optional            | AudioWorklet run in three browsers required for the decision        | Node missed the slowdown that caused the revert  |
| —                                | Reverted SIMD variant as an extra option                            | Tests the revert hypothesis directly             |
| —                                | Real-input gain reported separately from the SIMD gain              | ≈ 2× without SIMD for analyser and `signalsmith` |

## Options

| Id          | What                                                                  | Inverse | Build             |
|-------------|-----------------------------------------------------------------------|---------|-------------------|
| `analyser`  | Size-generic copy of `AudioAnalyser::fft`                             | no      | no_std-compatible |
| `rfft`      | `dsp::rfft::FftTables`, called directly                               | yes     | no_std            |
| `signalsmith` | `signalsmith::fft::Fft`, called directly, `im = 0` as its consumer does | yes   | no_std + alloc    |
| `reverted`  | `signalsmith::fft` as of `7998a6b64` (strided gathers, stages 1–2 scalar) | yes | no_std + alloc    |
| `realfft`   | `realfft` 3.5 over `rustfft` 6.4, `wasm_simd` on wasm32; candidate, as the plan asks | yes | std   |
| `proto`     | Day-2 SIMD kernel, added later through the same interface             | yes     | no_std            |

`reverted` is a verbatim copy of the file at `7998a6b64` (project code, AGPL-3.0), kept in the harness
only. `proto` must also expose a stage-wise API (`bit_reverse` / `stage(level)` / `scale` or an
equivalent) so `signalsmith` can keep spreading a frame over render quanta.

## Shared interface

All options implement one trait, so the prototype plugs in without harness changes:

- `new(n)`: plan creation; the only place allowed to allocate.
- `forward(input: &[f32], re: &mut [f32], im: &mut [f32])`: N real samples in, N/2 + 1 bins out,
  split layout, unnormalized (`X_k = Σ x_n e^{−2πikn/N}`).
- `inverse(re, im, output) -> bool`: returns `false` if the option has no inverse; output scaled so
  forward → inverse is identity.
- Scratch is owned by the option and created in `new`.

Accuracy uses this interface (adapters convert layout and scaling). Benchmarks call each option's
native API, so adapter copies are not timed. Input is refreshed before every timed call for all
options alike (`realfft` uses its input as scratch).

## Accuracy

Signals, every N in {256, 512, …, 16384}:

| Signal          | Definition                                    | Gate or report |
|-----------------|-----------------------------------------------|----------------|
| Impulse         | `x[0] = 1`                                    | gate           |
| DC              | `x = 1`                                       | gate           |
| Sine on bin     | bin N/32, amplitude 0.5 (analyser fixture)    | gate           |
| Sine off bin    | bin N/32 + 0.5, amplitude 0.5                 | gate           |
| White noise     | xorshift32, seed `0x12345678`, ±0.2           | gate           |
| Full scale      | white noise ±1.0 and sine amplitude 1.0       | gate           |
| Denormal range  | white noise × 1e-39                           | report only    |

Metrics:

| Metric                     | Definition                                               | Target                         |
|----------------------------|----------------------------------------------------------|--------------------------------|
| Rel. RMS vs f64 DFT        | `sqrt(Σ\|X − X_ref\|² / Σ\|X_ref\|²)`                    | ≤ 2× baseline (see deviations) |
| Round trip                 | `max \|x − inverse(forward(x))\|`, white noise           | < 1e-5                         |
| Parseval                   | rel. diff of `Σx²` and one-sided `Σ\|X\|² / N`           | report                         |
| Analyser contract (N=1024) | `max \|B_new − B_old\| / max \|B_old\|` on analyser bins | ≤ 1e-5                         |

- **f64 reference:** exact DFT of the same f32 input in f64, twiddles from an index table
  `(k·n) mod N` to avoid phase drift. O(N²); tests build with `opt-level = 3`.
- **Analyser contract:** each option runs the analyser's own steps at N = 1024 (Blackman window,
  forward, `sqrt` in f64, × 1/512, bins 0..512) and is compared to `AudioAnalyser::process` bins.
- **Faithful copy check:** the `analyser` copy must give bit-identical bins to `AudioAnalyser` at
  N = 1024.

## Performance

| Item              | Native                         | Node (wasm32 + simd128)                                         |
|-------------------|--------------------------------|-----------------------------------------------------------------|
| Tool              | Criterion                      | `run.mjs`, modelled on `signalsmith-wasmbench/run.mjs`          |
| Throughput        | Criterion per-iteration        | `run(count)` export loops in wasm; batches ≥ 10 ms              |
| Single call       | Criterion at each N            | `hrtime` per call; median, p99; flagged where timer cost > 5%   |
| Statistics        | Criterion CI                   | ≥ 30 batches; median; 95% CI by bootstrap; target half-width ≤ 5% |
| Warm-up           | Criterion default              | 200 calls, discarded                                            |
| Directions        | forward; inverse where present | same                                                            |
| Stage-wise        | —                              | time per `stage(level)` for `signalsmith`, `reverted`, `proto`  |

Derived per N: % of the 128-frame render quantum (2.667 ms at 48 kHz).

**Budget per consumer** (question 3), each at its real call pattern:

| Consumer                     | Call pattern                                                        |
|------------------------------|---------------------------------------------------------------------|
| Analyser                     | 1 forward, N = 1024, per 1024 frames (8 quanta)                     |
| Time-stretch (`signalsmith`) | per region and channel: 1 forward + 1 inverse, N = 4096, per 1024 frames; peak step per quantum |
| Convolver (`dsp::rfft`)      | forward + inverse at N = 256 every quantum, N = 2048 and 16384 spread over their periods |

Reported as % of budget saved for 1, 3 and 5 regions (the counts in `d02dc79b8`) and for the plan's
proposal (V = 16, P = 25%).

**Where numbers come from:**

- Native: development only. `realfft` uses NEON on Apple Silicon there and does not predict wasm.
- Node: fast iteration; results are preliminary (Node did not show the slowdown behind the revert).
- AudioWorklet in Chrome, Firefox and Safari: decides. The same wasm module runs in Node and in the
  worklet, so it must not need any imports.

## Gates

| Gate                         | Method                                                                                   |
|------------------------------|------------------------------------------------------------------------------------------|
| No allocation after plan     | Test with a counting global allocator: zero allocations in `forward`/`inverse`, all N    |
| `no_std` / talc              | Compile check: a `no_std` stub crate depending on each option for `wasm32-unknown-unknown`|
| Binary size                  | One tiny module per option, engine flags (`+simd128`, opt-level 3, LTO, `wasm-opt -Oz`, same feature set as `build-wasm.sh`), gzip -9; delta vs an empty module |
| Dependency footprint         | `cargo tree -e normal`: crate count and names                                            |
| License                      | From crate metadata (done: MIT / MIT OR Apache-2.0)                                     |
| Project policy               | Homebrew only (`plans/wasm-audio/README.md`); open for `realfft`: exception for an FFT library? (baseline analysis, section 7) |

For `realfft` the size delta includes `std` (allocator, panic machinery); reported separately.

## Environment record

Every run prints and stores: CPU model and architecture, OS version, `rustc` and `node` versions,
git short hash plus dirty flag, crate versions, `RUSTFLAGS`. Browser name and version join later.

## Layout

```
crates/fft-bench/            excluded from the workspace (like signalsmith-wasmbench)
  Cargo.toml                 dsp, math, signalsmith, libm, realfft; dev: criterion; [profile.test] opt-level 3
  src/lib.rs                 trait, option registry
  src/options/{analyser,rfft,signalsmith,reverted,realfft}.rs
  src/{reference,signals,metrics,env}.rs
  src/wasm.rs                wasm32 exports: setup(option, n), run(count), step()
  tests/{faithful_copy,accuracy,allocation}.rs
  benches/fft.rs
  examples/report.rs         accuracy table to stdout
  run.mjs                    Node runner
  size/                      one stub crate per option + empty, size.sh, nostd-check.sh
```

Results go to `analysis/results/` (private), not into the crate.

## Work order and commits

| #  | Commit                                                   | Est.   | State |
|----|----------------------------------------------------------|--------|-------|
| 1  | Crate skeleton, workspace exclude, trait                 | 15 min | done  |
| 2  | `analyser` copy + faithful-copy test, first signals      | 30 min | done  |
| 3  | f64 reference, remaining signals, metrics, `rfft` option | 45 min | done  |
| 4  | `signalsmith` and `reverted` options                     | 30 min | done  |
| 5  | `realfft` option, accuracy tests, report example         | 30 min | done  |
| 6  | Allocation test                                          | 15 min | done  |
| 7  | Criterion benches + environment record                   | 30 min |       |
| 8  | wasm exports (import-free) + `run.mjs`, stage timing     | 60 min |       |
| 9  | Budget-per-consumer report                               | 30 min |       |
| 10 | Size stubs, `size.sh`, `nostd-check.sh`                  | 45 min |       |

About 5.5 h against the plan's 3.5 h. The extra comes from the third baseline, the reverted variant
and the budget report. If Day 1 runs short, 10 moves to Day 2 morning. Note that 10 delivers the
binary size and `no_std` numbers the `realfft` decision needs.

## Out of scope here

The AudioWorklet page (step 3, separate PR, but required before a decision), the prototype kernel
(Day 2), any change to `AudioAnalyser`, `dsp::rfft` or `signalsmith`.
