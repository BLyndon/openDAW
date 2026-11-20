# SIMD FFT: baseline analysis

Step 1 of `plans/simd-fft-harness.md` (baseline analysis). Source: `crates/dsp/src/analyser.rs` at
commit `bb93a24b1`; line numbers refer to that commit. No code was changed.

## Current state

Requirements from `future-plans/simd-fft.md` against what exists. `realfft`/`rustfft` from the
crate sources (realfft 3.5.1, rustfft 6.4.1), not yet measured.

| Requirement              | Analyser FFT (`dsp::analyser`) | `dsp::rfft`                    | `realfft`/`rustfft`             |
|--------------------------|--------------------------------|--------------------------------|---------------------------------|
| Real-input (N/2 + twist) | no, full N complex             | yes                            | yes                             |
| Layout                   | split re/im                    | split re/im                    | interleaved `Complex<f32>`      |
| Sizes                    | fixed 1024                     | any power of two               | any                             |
| Inverse                  | no                             | yes, round trip = identity     | yes, unnormalized (×N)          |
| Hann helpers             | no (Blackman window inline)    | no                             | no                              |
| Explicit SIMD128         | no (autovectorisation only)    | no (autovectorisation only)    | yes, `wasm_simd` feature        |
| No allocation after plan | yes                            | yes                            | yes, with caller scratch        |
| `no_std` (engine, talc)  | yes                            | yes                            | no, needs `std` (`Arc`)         |
| Twiddles                 | f64 → f32, one strided table   | f64 → f32, one strided table   | per-plan                        |
| License                  | project (AGPL-3.0)             | project (AGPL-3.0)             | MIT / MIT OR Apache-2.0         |
| Render-path consumers    | analyser editors, N = 1024     | Convolver N = 256/2048/16384   | none                            |
| Performance              | not measured                   | not measured                   | not measured                    |

## 1. The current FFT runs a full N-point complex transform on real input

Confirmed.

- `imag` is only ever zeroed (`init`, line 59; end of `update`, line 112) and permuted by the
  bit-reversal swap (line 123). `process` and `analyse_ring` write only `real`. The imaginary
  input is always zero.
- `fft()` computes all 1024 complex outputs; `update()` reads only bins `0..NUM_BINS` (512, line 101).
  For real input the upper half is the complex conjugate mirror of the lower half and is discarded.

**Consequence:** the real-input trick (N/2-point complex FFT + post-twiddle) saves roughly 2× before
any SIMD. Report this gain separately from the SIMD gain so the two are not conflated.

## 2. Stage/shuffle claim: shuffles are needed in the first two stages, not the last two

The butterfly pairs `j` with `j + half_size` (line 135), and `half_size` doubles per stage starting at 1
(`size` starts at 2, line 126). In split re/im layout (SoA) one `f32x4` holds four consecutive indices:

| Stage | Distance | Partners                               | SIMD           |
|-------|----------|----------------------------------------|----------------|
| 1     | 1        | lanes 0↔1, 2↔3 inside one vector       | shuffle needed |
| 2     | 2        | lanes 0↔2, 1↔3 inside one vector       | shuffle needed |
| 3–10  | 4…512    | same lane, different vectors           | lane-parallel  |

`future-plans/simd-fft.md` states the opposite ("first stages lane-parallel, the last two need one
shuffle each"). That ordering holds for decimation-in-frequency (natural-order input, largest distance
first). The current code is decimation-in-time after bit reversal, where the shuffles come first.

A radix-4 first pass can merge stages 1 and 2 into one 4-point DFT per vector, done via a 4×4
transpose, leaving a single shuffle pass.

## 3. Further observations relevant to the harness and kernel

- **Fixed size.** `FFT_SIZE` is a compile-time 1024 (line 8). To measure N = 256–8192 the harness needs
  a size-generic scalar copy of the same loop, since `AudioAnalyser` must not change. That copy must be
  verified against the analyser output at N = 1024 so it is a faithful baseline.
- **Strided twiddle access.** One shared table of N/2 entries is walked with `k += table_step`
  (line 148). In a lane-parallel stage the four lanes need twiddles `table_step` apart, i.e. not
  contiguous. A SIMD kernel needs a contiguous twiddle table per stage (matches the "pre-splatted per
  stage" idea in the design sketch).
- **Trivial twiddles.** Stage 1 only uses k = 0 (multiply by 1); stage 2 uses k = 0 and k = N/4
  (multiply by 1 and −i). These multiplies can be skipped entirely.
- **Per-call overhead outside the butterflies.** Bit reversal computes `reverse()` per index on every
  call (line 120), and `update()` adds the window multiply and an f64 `sqrt` per bin (line 104). Time
  `fft()` on its own and the full `update()` separately so these do not blur the FFT speedup.
- **Sign convention.** `p = x · (cos − i·sin)` (lines 140–141), the standard forward DFT
  `e^{−2πi·jk/N}`. The f64 reference DFT in the accuracy suite must use the same sign.
- **Twiddle precision.** Twiddles are computed in f64 and rounded to f32 (lines 48–50). A new kernel
  should do the same to stay within the accuracy targets.

## 4. A second FFT already exists: `dsp::rfft`

Found while starting the harness. `crates/dsp/src/rfft.rs` (`FftTables<CAP>`, added with the convolver
in `8cb020039`) is not mentioned in `future-plans/simd-fft.md`, which calls the analyser FFT "the only
FFT we have".

- **Already a real-input FFT:** N/2-point complex radix-2 DIT on split re/im arrays plus a post-twist
  (lines 84–115), with a matching inverse (lines 117–147). Output is N/2 + 1 bins, split layout.
- **Already allocation-free and size-generic:** tables are built in place by `init(n)`; buffers and
  scratch are caller-provided. This is the API shape the requirements ask for.
- **Same butterfly loop as the analyser** (lines 52–81): same stage order, same strided twiddle
  access (`k += table_step`). The stage/shuffle finding in section 2 applies unchanged.
- **Consumers on the render path:** `dsp::convolution` (Convolver device) runs it at partition sizes
  b = 128, 1024, 8192, i.e. **FFT sizes 256, 2048 and 16384** (`Level`, `FFT == 2 * b`, line 45;
  bins constants lines 238–240). `device-mastering` uses the inverse at up to `MAX_TAPS` = 16384.

**Consequences for the evaluation:**

- Finding 1's "≈ 2× from the real-input trick" applies to the analyser only. `dsp::rfft` already has
  that gain, so for it any further speedup has to come from SIMD alone.
- There are two scalar baselines: the analyser FFT (full complex, fixed 1024) and `dsp::rfft`
  (real-input, generic N). `dsp::rfft` is public, so the harness can call it directly; no copy needed.
- The convolver needs N = 16384, outside the plan's 256–8192 range.
- The convolver is an existing render-thread consumer, so "fast convolution" in the plan's
  Consumers list is not a future candidate.
