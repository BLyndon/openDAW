# SIMD FFT: baseline analysis

Step 1 of `plans/simd-fft-harness.md` (baseline analysis). Sources at commit `bb93a24b1`; line
numbers refer to that commit. Sections 1–3 cover `crates/dsp/src/analyser.rs`, sections 4–7 the
FFTs found later. No code was changed.

## Current state

Requirements from `future-plans/simd-fft.md` against the three FFTs on the render path and the library
candidate. `realfft`/`rustfft` from the crate sources (realfft 3.5.1, rustfft 6.4.1).

| Requirement              | `dsp::analyser`              | `dsp::rfft`                  | `signalsmith::fft`                  | `realfft`/`rustfft`        |
|--------------------------|------------------------------|------------------------------|-------------------------------------|----------------------------|
| Real-input (N/2 + twist) | no, full N complex           | yes                          | no, full N complex both directions  | yes                        |
| Layout                   | split re/im                  | split re/im                  | split re/im                         | interleaved `Complex<f32>` |
| Sizes                    | fixed 1024                   | any power of two             | any power of two                    | any                        |
| Inverse                  | no                           | yes, identity round trip     | yes, scaled 1/N                     | yes, unnormalized (×N)     |
| Stage-wise API           | no                           | no                           | yes (`bit_reverse`/`stage`/`scale`) | no                         |
| Hann helpers             | no (Blackman inline)         | no                           | no (Kaiser OLA window separate)     | no                         |
| Explicit SIMD128         | no                           | no                           | no (tried and reverted, section 6)  | yes, `wasm_simd` feature   |
| No allocation after plan | yes                          | yes                          | yes                                 | yes, with caller scratch   |
| `no_std` (engine, talc)  | yes                          | yes                          | yes (`alloc`)                       | no, needs `std` (`Arc`)    |
| Twiddles                 | f64 → f32, strided           | f64 → f32, strided           | f64 → f32, strided                  | per plan                   |
| Project policy           | homebrew                     | homebrew                     | homebrew                            | third-party (section 7)    |
| License                  | AGPL-3.0                     | AGPL-3.0                     | AGPL-3.0                            | MIT / MIT OR Apache-2.0    |
| Render-path consumers    | analyser editors, N = 1024   | Convolver, N = 256/2048/16384| time-stretch per region, N = 4096   | none                       |
| Accuracy (worst rel. RMS)| 1.4e-7 (section 9)           | 1.5e-7 (section 9)           | 1.4e-7, = analyser (section 9)      | not measured               |
| Measured cost            | none                         | none                         | whole frame, see section 6          | none                       |

Not on the render path: `stretch::fft` (analysis in the core worker) and `matchering::fft` (f64,
offline). Both are scalar radix-2 as well.

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

- **Fixed size.** `FFT_SIZE` is a compile-time 1024 (line 8). To measure N = 256–16384 the harness needs
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
- **The window is Blackman-Harris, not Blackman.** The coefficients 0.42323 / 0.49755 / 0.07922
  (lines 52–56, mirroring TS `Window.create(Blackman, n)`) are the 3-term Blackman-Harris window
  (≈ −67 dB sidelobes), not the classic Blackman 0.42 / 0.5 / 0.08 (≈ −58 dB). Only the name is off;
  the output contract keeps these exact values. No effect on the FFT comparison.

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
- `dsp::rfft` is a second scalar baseline (real-input, generic N); a third follows in section 5.
  `dsp::rfft` is public, so the harness can call it directly; no copy needed.
- The convolver needs N = 16384, outside the plan's 256–8192 range.
- The convolver is an existing render-thread consumer, so "fast convolution" in the plan's
  Consumers list is not a future candidate.

## 5. FFT inventory: what came after the plan

`future-plans/simd-fft.md` was written on 2026-07-12 (`58556bfc8`).

| Date       | FFT / event                                 | Commit      | Render path |
|------------|---------------------------------------------|-------------|-------------|
| 2026-07-05 | `dsp::analyser`                             | `250609d8a` | yes         |
| 2026-07-10 | `stretch::fft`                              | `a9f52209e` | no (worker) |
| 2026-07-12 | **plan written**                            | `58556bfc8` |             |
| 2026-07-12 | `signalsmith::fft`                          | `820b51ef6` | yes         |
| 2026-07-15 | SIMD butterflies in `signalsmith::fft`      | `7998a6b64` | yes         |
| 2026-07-15 | ...reverted 43 minutes later                | `3628e040e` |             |
| 2026-08-25 | `dsp::rfft` (convolver)                     | `8cb020039` | yes         |
| 2026-10-31 | `matchering::fft` (f64)                     | `0fdd8d4b8` | no          |
| 2026-11-18 | `signalsmith` splits a frame over quanta    | `d02dc79b8` | yes         |

All five are separate homebrew radix-2 DIT implementations with the same strided-twiddle loop.
`stretch::fft` and `signalsmith::fft` are near copies.

`signalsmith::fft` (`crates/signalsmith/src/fft.rs`) in detail:

- **Consumer:** `SignalsmithStretch`, one instance per playing region, in the engine. Block 4096,
  interval 1024 (`stretch.rs` lines 102–106).
- **Real-input waste in both directions:** `analyse` zeroes `im` before `forward` (lines 645–647);
  `synthesise` builds the Hermitian mirror before `inverse` (lines 663–668). Both are full 4096-point
  complex transforms on real data, so the real-input trick saves ≈ 2× here too, as for the analyser.
- **Stage-wise API:** `bit_reverse`, `stage(level)` and `scale` are public so the frame's work can be
  spread over several render quanta (`splitComputation`, `d02dc79b8`; steps in lines 491–566). Any
  replacement must keep this API or the consumer loses its peak smoothing.

## 6. A SIMD FFT was already tried and reverted

`7998a6b64` vectorised the `signalsmith::fft` butterflies; `3628e040e` reverted it the same day.
From the commit messages:

- **What it did:** 4 butterflies per `f32x4` for distance ≥ 4. The first two stages and the bit
  reversal stayed scalar. Twiddles stayed strided and were gathered lane by lane. Bit-identical output.
- **Most input vectors are built lane by lane** (found in the code and the compiled wasm, not in the
  commit message). In source, `Simd4::load` builds every vector from four scalar loads,
  `f32x4(slice[0], …, slice[3])`, and `Simd4::store` splits it with four `f32x4_extract_lane` calls
  (`simd.rs` at `7998a6b64`), even for contiguous data. LLVM repairs part of that. Compiled through
  `fft-bench` for wasm32 (`+simd128`, opt-level 3, LTO, no `wasm-opt`; inspected with `wasm-dis`),
  one group of 4 butterflies has:

  | Vector          | Compiled as                                                             |
  |-----------------|-------------------------------------------------------------------------|
  | `re` even/odd   | `v128.load`                                                             |
  | `im` even/odd   | lane by lane: `f32x4.splat(f32.load)` + 3 `replace_lane`/`load32_lane`  |
  | `cos` / `sin`   | lane by lane, same pattern (strided gathers)                            |
  | all 4 stores    | `v128.store`                                                            |

  So 10 vector arithmetic operations are fed by 2 vector loads plus 16 scalar reads and 12 lane
  inserts. The engine build may differ in detail. A concrete, testable explanation for the browser
  slowdown, next to the gathered twiddles the commit names: lane inserts are cheap for an optimising
  compiler and likely expensive for a baseline tier.
- **Gain:** frame p99 5.3% → 5.0% of the budget (wasmbench); about 12% on the vocoder frame in Node,
  ≈ 0.6% of the budget overall.
- **Why reverted:** a studio report showed a large slowdown that Node could not reproduce. The
  maintainer's hypothesis: the browser's audio-thread wasm tier handles `f32x4`, especially the lane
  gathers, much worse than Node's optimising compiler. Judged not worth the risk for ≈ 0.6%.
- **Cost since then:** with `splitComputation` the peak per render quantum is 1.3% for 1 voice,
  3.6% for 3, 8.2% for 5 (wasm engine, `d02dc79b8`). These are whole frames, not the FFT alone.

How the planned kernel differs from that attempt:

| Aspect             | Reverted attempt (`7998a6b64`) | Planned kernel                            |
|--------------------|--------------------------------|-------------------------------------------|
| Stages 1–2         | scalar                         | vectorised (radix-4 first pass, transpose)|
| Twiddles           | strided, gathered per lane     | contiguous per stage, plain vector loads  |
| Data loads         | `re` vector, `im` lane by lane (compiled) | `v128_load` for all             |
| Real input         | full N complex                 | N/2 complex + post-twist                  |
| Measured in        | Node only                      | Node and AudioWorklet in three browsers   |

## 7. Dependency policy

`plans/wasm-audio/README.md` (lines 23–25): "All homebrew. No third-party DSP … licensing" and
"Minimal dependencies". `stretch::fft` and `signalsmith::fft` state "no rustfft — dependency policy"
in their headers. So `realfft`/`rustfft` very likely fails a policy gate regardless of speed, besides
the `no_std` gap. It stays useful as a reference for what a mature SIMD FFT reaches.

## 8. Consequences for the evaluation

The question stays: **how much faster can the FFT get with SIMD128?** Two questions are added:

- **Why would it work this time?** The harness has to measure in an AudioWorklet in real browsers,
  since Node did not show the slowdown that led to the revert. Reproducing the reverted variant
  as an option tests the maintainer's hypothesis directly.
- **Is it worth it?** Report savings as % of the render budget for each consumer's real call
  pattern, not only as a speed factor.

Further:

- Three scalar baselines on the render path: analyser (1024), `dsp::rfft` (up to 16384),
  `signalsmith::fft` (4096).
- The real-input trick alone (≈ 2× for analyser and `signalsmith`, no SIMD, no browser-tier risk)
  must be reported separately from the SIMD gain.
- A new kernel needs a stage-wise API for `signalsmith`.
- `future-plans/simd-fft.md` is outdated in: "the only FFT we have" (section 4), the consumers list
  (sections 4–5), the stage order (section 2), the library alternative (section 7), and it does not
  mention the reverted attempt (section 6).

## 9. Accuracy of the baselines (measured)

`crates/fft-bench` at `ccf110571`, native release build. Apple M1 (arm64), macOS 27.0.1,
rustc 1.93.0. Measured 2026-11-21. Signals and metrics as in `analysis/simd-fft-harness-spec.md`.

Worst value over the seven gated signals per size (the denormal signal is listed separately):

| N     | Analyser rel. RMS | `rfft` rel. RMS | Analyser Parseval | `rfft` Parseval | `rfft` round trip | Denormal rel. RMS (analyser / `rfft`) |
|-------|-------------------|-----------------|-------------------|-----------------|-------------------|---------------------------------------|
| 256   | 1.1e-7            | 1.1e-7          | 9.0e-8            | 5.6e-8          | 4.5e-8            | 6.3e-7 / 4.4e-7                       |
| 512   | 1.1e-7            | 1.2e-7          | 6.0e-8            | 7.0e-8          | 7.5e-8            | 5.4e-7 / 4.0e-7                       |
| 1024  | 1.2e-7            | 1.4e-7          | 8.4e-8            | 8.8e-8          | 8.9e-8            | 5.4e-7 / 4.1e-7                       |
| 2048  | 1.4e-7            | 1.4e-7          | 1.5e-7            | 1.5e-7          | 7.5e-8            | 5.8e-7 / 4.1e-7                       |
| 4096  | 1.3e-7            | 1.4e-7          | 6.8e-8            | 6.2e-8          | 9.7e-8            | 5.9e-7 / 4.2e-7                       |
| 8192  | 1.4e-7            | 1.4e-7          | 6.2e-8            | 9.0e-8          | 9.1e-8            | 5.8e-7 / 4.2e-7                       |
| 16384 | 1.4e-7            | 1.5e-7          | 1.0e-7            | 9.5e-8          | 1.3e-7            | 5.8e-7 / 4.2e-7                       |

Analyser output contract at N = 1024, `rfft` against the analyser copy:

| Signal           | Deviation |
|------------------|-----------|
| impulse          | 0         |
| DC               | 1.9e-8    |
| sine on bin      | 4.5e-8    |
| sine off bin     | 8.0e-8    |
| white noise      | 1.8e-7    |
| full-scale noise | 1.5e-7    |
| full-scale sine  | 4.5e-8    |
| denormal noise   | 0 (both bin sets all zero) |

`signalsmith::fft` and the reverted SIMD variant (fft-bench commit 4, same environment): worst
relative RMS 1.4e-7, Parseval 1.5e-7, round trip 1.0e-7, denormal 6.3e-7, all over 256–16384. The
reverted variant gives the same bits as today's `signalsmith::fft` natively, forward and inverse
(there it runs its scalar `Simd4` fallback).

**`signalsmith::fft` is numerically the analyser FFT.** Its contract deviation against the analyser is
exactly 0 for every gated signal. Both use the same butterfly order; `signalsmith` stores the sine
table with the opposite sign and subtracts where the analyser adds, and `a − b·(−s)` equals `a + b·s`
exactly in IEEE arithmetic. Two of the three render-path baselines are therefore one FFT in numbers;
they differ only in code shape (fixed size and arrays vs. runtime size, slices and a precomputed
bit-reversal table), which can still matter for speed.

Takeaways:

- **All baselines work at f32 resolution** (ε ≈ 1.2e-7). Every plan target is met with about two
  orders of magnitude to spare: round trip ≤ 1.3e-7 against 1e-5, contract ≤ 1.8e-7 against 1e-5.
- **The "≤ 2× baseline" gate is tight in absolute terms.** A new kernel must stay at about
  ≤ 3e-7 relative RMS. Reordered sums in a radix-4 or vectorised kernel are normally within that,
  but this gate, not the plan's 1e-5, is the one that can actually fail.
- **`dsp::rfft` meets the analyser contract.** The real-input trick costs the analyser no visible
  accuracy (≤ 1.8e-7 against ε = 1e-5), so its ≈ 2× gain is available without SIMD.
- **Denormal input zeroes the analyser bins.** `update()` squares `re`/`im` in f32 before the cast to
  f64 (`analyser.rs` line 104): below ≈ 1e-19 the squares lose precision, below ≈ 4e-23 they are 0.
  That is beyond −380 dB, so it has no audible or visible effect; it only explains the all-zero bins
  in the contract row above.
