# SIMD FFT: findings

What the analysis of the existing code found, as far as it bears on the decision. Each finding gives its evidence.
Measured results are in [README.md](README.md).

## 1. The analyser transforms real input as a full complex FFT

`dsp::analyser` runs a 1024-point complex FFT with the imaginary input always zero, then reads only the lower
512 bins (`crates/dsp/src/analyser.rs`).

**Consequence:** a real-input FFT (N/2-point complex transform plus a post-twiddle) halves its work before any
SIMD. Measured: about 1.7× (`rfft` against the analyser, Node). This gain has to be reported apart from the
SIMD gain.

## 2. In a radix-2 DIT FFT, the shuffles are needed in the first stages, not the last

After bit reversal, stage 1 pairs neighbouring elements (distance 1) and stage 2 elements at distance 2. Both pairs
sit inside one `f32x4`, so these stages need shuffles. From distance 4 on, stages are lane-parallel.

`future-plans/simd-fft.md` says the opposite. That would hold for decimation in frequency, but every FFT in the
repository is decimation in time. The prototype kernel pays for its shuffles once, in a 4×4 transpose in the first
stage.

## 3. A real-input FFT already exists: `dsp::rfft`

`crates/dsp/src/rfft.rs` (`8cb020039`) is already a real-input FFT: split re/im, any power of two, no allocation.
The plan says the analyser FFT is "the only FFT we have"; that is not the case.

- **Consumers on the render path:** the Convolver at N = 256, 2048 and 16384, and `device-mastering` up to
  16384. Fast convolution is therefore a current consumer, not a future one.
- **Consequence:** against `rfft`, any speed-up has to come from SIMD and the algorithm alone.

## 4. Five homebrew FFTs, all the same scalar radix-2 loop

| FFT                | On the render path | Consumer                                                         |
| ------------------ | ------------------ | ---------------------------------------------------------------- |
| `dsp::analyser`    | yes                | analyser editors, N = 1024                                       |
| `dsp::rfft`        | yes                | Convolver, mastering                                             |
| `signalsmith::fft` | yes                | time-stretch per region, N = 4096, two real channels per call    |
| `stretch::fft`     | no (worker)        | analysis                                                         |
| `matchering::fft`  | no (f64, offline)  | matchering                                                       |

All five use strided twiddle access and bit reversal per call.

**Consequence:** `signalsmith` gains nothing from the real-input trick, because it already carries left and right
in re and im. It splits each transform over render quanta (`d02dc79b8`), so a replacement needs a stage-wise API.
The prototype's `simd-complex` provides one.

## 5. A SIMD FFT was tried once and reverted the same day

`7998a6b64` vectorised `signalsmith::fft`; `3628e040e` reverted it 43 minutes later.

- **Gain in Node:** about 1.2×, measured again here: `reverted` against `signalsmith`.
- **Why it was reverted:** the studio showed a slowdown that Node did not reproduce. The maintainer's hypothesis
  is that the browser's audio-thread tier handles `f32x4` poorly.
- **What the compiled wasm shows:** most input vectors were built lane by lane. Strided twiddles and the
  imaginary parts were assembled from scalar loads plus lane inserts, and stages 1–2 and the bit reversal
  stayed scalar.

**The prototype avoids all of these:** only `v128.load`/`v128.store`, contiguous per-stage twiddles, no bit
reversal, and vectorised first stages. Whether that holds in the audio-thread tier can only be settled by browser
measurements.

## 6. Dependency policy and `no_std` make the library a gate question, not an exclusion

- **Policy:** "All homebrew. No third-party DSP … Minimal dependencies" (`plans/wasm-audio/README.md`). The headers
  of `stretch::fft` and `signalsmith::fft` say "no rustfft — dependency policy".
- **The plan is newer:** `future-plans/simd-fft.md` was written after the policy and asks to measure `realfft`
  before deciding. No later commit decides against the library.
- **`no_std`:** the engine has been `no_std` since `af8e8c3f7`. `realfft`/`rustfft` need `std` and fail to link
  with the engine's own panic handler (duplicate `panic_impl`).

**Open for the maintainer:** does the policy allow an exception for an FFT, and would a `no_std` variant of the
library be acceptable?

## 7. Accuracy does not decide

- **All options are accurate.** Every option, baseline or candidate, sits at f32 resolution: relative RMS
  1.1–1.5e-7 against an f64 DFT. Round trip and analyser contract stay ≤ 2.2e-7, about 50× below the plan's 1e-5.
- **The binding gate:** "≤ 2× the error of the current FFT", which in absolute terms means about ≤ 2.4e-7 relative
  RMS. The prototype passes it at every size: radix-4 rounds less often than radix-2.
- **`signalsmith::fft` gives the same bits as the analyser.** Same butterfly order; the opposite sign convention
  cancels exactly in IEEE arithmetic.

## Where `future-plans/simd-fft.md` is outdated

- "the only FFT we have" (finding 3);
- the list of consumers (findings 3, 4);
- the stage/shuffle order (finding 2);
- the reverted attempt is not mentioned (finding 5);
- `no_std` is not addressed (finding 6).

Its library alternative still stands.
