# Testing concept

What the harness tests, against what, and where each threshold comes from.

## Goal

The harness enables its user to answer three questions and to decide on them, based on measured
numbers:

1. **How much faster can the FFT get with WebAssembly SIMD128?** Needs the speed of each option.
2. **Why would it work this time?** A SIMD pass on `signalsmith::fft` was tried and reverted
   (`7998a6b64`, `3628e040e`): small gain in Node, a slowdown in the browser that Node did not show.
   Needs the reverted variant measured in the browser, next to any new kernel.
3. **Is it worth it?** Needs time per call as a share of the render budget per consumer, not only
   relative speed.

Speed only matters for an option that is accurate enough, so accuracy is tested first. The gates below
are pass/fail checks on accuracy; everything else is reported for the person comparing the options.

## Options under test

| Option        | Role      | What                                                                 |
|---------------|-----------|----------------------------------------------------------------------|
| `analyser`    | baseline  | Size-generic copy of `AudioAnalyser::fft` (full N-point complex)     |
| `rfft`        | baseline  | `dsp::rfft` (real input, N/2 complex + post-twist), used by the Convolver |
| `signalsmith` | baseline  | `signalsmith::fft` (full N-point complex), used by the time-stretch  |
| `reverted`    | baseline  | `signalsmith::fft` as of `7998a6b64`, the reverted SIMD pass         |
| `realfft`     | candidate | `realfft`/`rustfft`, the library alternative from `future-plans/simd-fft.md`; open gate questions: third-party DSP, needs `std` |
| prototype     | candidate | The SIMD kernel under evaluation (planned)                           |

**Baselines** set the gates, **candidates** must pass them.

## Test levels

| Level                  | Question                                         | Where                                  |
|------------------------|--------------------------------------------------|----------------------------------------|
| 1. Tool self-tests     | Are the reference DFT and the metrics right?      | `tests/accuracy.rs`                    |
| 2. Faithful copies     | Does each copy compute exactly what its original does? | `tests/faithful_copy.rs`          |
| 3. Baseline sanity     | Are the baselines at f32 resolution?             | `tests/accuracy.rs`                    |
| 4. Candidate gates     | Does every non-baseline meet the plan's targets? | `tests/accuracy.rs`                    |
| 5. Mutation checks     | Can each test actually fail?                     | by hand, before a test is accepted     |

- **Level 1:** the reference DFT must give known answers (impulse → flat 1, DC → n at bin 0, a sine on
  bin k → amplitude · n/2 at k). The metrics must flag known errors (a doubled spectrum is 100 % off in
  relative RMS and shows 4× the energy in Parseval).
- **Level 2:** bit-for-bit, not within a tolerance. The `analyser` copy against `AudioAnalyser` at its
  own size, 1024. The `reverted` copy against today's `signalsmith::fft`, natively, where it runs its
  scalar `Simd4` fallback.
- **Level 5:** each new test is run once against a deliberately broken implementation (a flipped sign,
  f32 instead of f64 twiddles, a 1e-6 scale error) and must fail. The mutation is then reverted.

## Two references

- **Absolute:** an exact DFT of the same f32 input, computed in f64 (`reference::dft`). Twiddles come
  from a table indexed by `(j·k) mod n`, so no angle error accumulates.
- **Output contract:** the analyser's own steps around its FFT (Blackman-Harris window, magnitude in
  f64, scale 1/(n/2)) at N = 1024, compared with `AudioAnalyser`'s bins (`contract.rs`). Editor views
  depend on these bins, so a new FFT must not change them visibly.

## Test signals

Every signal at every size, N = 256, 512, …, 16384 (`signals.rs`).

| Signal           | Definition                                         | Gated |
|------------------|----------------------------------------------------|-------|
| impulse          | `x[0] = 1`                                         | yes   |
| DC               | `x = 1`                                            | yes   |
| sine on bin      | bin N/32, amplitude 0.5 (the analyser's fixture)   | yes   |
| sine off bin     | bin N/32 + 0.5, amplitude 0.5 (worst leakage)      | yes   |
| white noise      | xorshift32, seed `0x12345678`, ±0.2                | yes   |
| full-scale noise | same generator, ±1.0                               | yes   |
| full-scale sine  | bin N/32, amplitude 1.0                            | yes   |
| denormal noise   | same generator, ±1e-39 (every sample subnormal)    | no, reported only |

## Metrics and thresholds

| Metric                 | Definition                                        | Threshold                     | Origin |
|------------------------|---------------------------------------------------|-------------------------------|--------|
| Relative RMS           | `sqrt(Σ\|X − X_ref\|² / Σ\|X_ref\|²)`             | candidate: ≤ 2 × max(`rfft`, ε<sub>f32</sub>) | plan; floor: harness |
| Round trip             | `max \|x − inverse(forward(x))\|`, white noise    | < 1e-5                        | plan |
| Parseval               | relative gap between `Σx²` and `Σ\|X\|² / n`      | reported                      | plan |
| Analyser contract      | `max \|B_new − B_old\| / max \|B_old\|`, N = 1024 | ≤ 1e-5 (≈ −100 dB)            | plan proposal |
| Baseline relative RMS  | as above                                          | < 1e-6                        | harness sanity bound |
| Baseline Parseval      | as above                                          | < 1e-6                        | harness sanity bound |

- **Gate floor:** every option is exact on the impulse (0) and at f64 noise on DC (≈ 1e-15). A plain
  "2× baseline" would then demand a bit-exact candidate. Below one f32 epsilon (1.19e-7) a result is as
  exact as f32 gets, so the gate never drops below 2 × 1.19e-7.
- **Sanity bounds:** 1e-6 is about 6× above the worst measured baseline value. It does not flake, and a
  real bug lands orders of magnitude above it.
- **Denormal input** is not gated: f32 has no precision left there, and the analyser squares in f32, so
  its bins are all zero.

## Performance (planned)

| Platform                        | Role                                                | Tool |
|---------------------------------|-----------------------------------------------------|------|
| Native                          | development only; `realfft` uses NEON/AVX there     | Criterion |
| Node (wasm32 + simd128)         | fast iteration; preliminary                         | `run.mjs` |
| AudioWorklet in Chrome, Firefox, Safari | the numbers that count; Node missed the slowdown behind the revert | browser page (separate PR) |

- **Single call and throughput:** per-call timing (per-call overhead matters at N = 256) and loops inside
  wasm (timer cost amortised).
- **Statistics:** median of many warm runs, 95 % confidence interval, target half-width ≤ 5 %.
- **Per stage:** time per `stage(level)` where an option has a stage-wise API (`signalsmith` spreads a
  frame over render quanta).
- **Budget per consumer:** savings as % of the 128-frame render quantum (2.667 ms at 48 kHz) at each
  consumer's real call pattern: analyser (N = 1024), time-stretch (N = 4096 per region and channel),
  Convolver (N = 256, 2048, 16384).
- **Real-input gain** is reported separately from the SIMD gain: `analyser` and `signalsmith` run full
  complex transforms on real data, so ≈ 2× is available without SIMD.

## Gates besides accuracy

| Gate                       | Method | Status |
|----------------------------|--------|--------|
| No allocation after plan   | counting global allocator: zero allocations in `forward`/`inverse`, every option and size, no warm-up call (`tests/allocation.rs`) | done |
| `no_std` (engine, talc)    | compile check of a `no_std` stub per option for `wasm32-unknown-unknown` | planned |
| Binary size                | one small module per option, engine flags, `wasm-opt -Oz`, gzip; delta to an empty module | planned |
| Dependency footprint       | `cargo tree`: crate count and names | planned |

## Not tested here

Production code is never changed by the harness. Replacing any FFT in the engine, the time-stretch and
the Convolver themselves, and the TypeScript `lib-dsp` FFT are out of scope.
