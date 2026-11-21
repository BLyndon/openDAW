# Plan: Benchmark harness and evaluation for the SIMD FFT

Companion to `future-plans/simd-fft.md`. This plan covers the measurement basis and a
prototype needed to decide how to implement the SIMD-optimised FFT. It does not change
production code.

> AI assistance: this work is done with Claude Code. All code is reviewed and understood
> line by line by the contributor before it is submitted.

## Goal

Answer two questions with measured numbers:

1. How much faster can the Rust/Wasm FFT (f32, real input, N = 256–8192) become on
   WebAssembly SIMD128 compared with the current scalar radix-2 in `crates/dsp/src/analyser.rs`?
2. Should the engine use `realfft`/`rustfft` or a custom SIMD kernel?

## Scope

### In

- Benchmark and accuracy harness (native + Node), no change to `AudioAnalyser`
- Comparison: current scalar radix-2 vs. `realfft`/`rustfft` vs. a prototype SIMD kernel
- Wasm binary size impact of each option
- A static browser page running the same harness in Chrome, Firefox and Safari

### Out

- Replacing `AudioAnalyser::fft` (follow-up, after a decision)
- Phase-vocoder time-stretch, fast convolution
- The TypeScript `lib-dsp` FFT
- Merging the prototype kernel (it stays on a separate branch for comparison)

## Approach

### 1. Baseline analysis

- Confirm whether the current FFT runs a full N-point complex transform on real input.
  This determines how much the real-input trick (N/2 complex + post-twiddle) can gain.
- Check which stages need shuffles in a split re/im layout. In radix-2 DIT after bit reversal,
  the first stages pair neighbouring elements (distance 1, 2), which sit inside one `f32x4`;
  the later stages (distance ≥ 4) are lane-parallel. The design sketch in
  `future-plans/simd-fft.md` states the opposite; this needs verification.

### 2. Accuracy

Two references:

- **Absolute accuracy:** exact DFT of the same f32 input, computed in f64.
- **Output contract:** the current analyser output (TS-faithful).
  Metrics:
- Round-trip error forward → inverse on white noise: < 1e-5 (from `future-plans/simd-fft.md`)
- Magnitude deviation from the current analyser, relative to the spectrum peak:
  `max |X_new − X_old| / max |X_old|` ≤ ε, proposed ε = 1e-5 (≈ −100 dB)
- Relative RMS error vs. the f64 reference: ≤ 2× the current implementation
- Parseval check (energy in time domain equals energy in frequency domain)
  Test signals: impulse, DC, sine on bin (existing fixture), sine between bins, white noise
  (fixed seed), full-scale signal, denormal-range values. All sizes 256–8192.

### 3. Performance

- Time per call for N = 256–8192: throughput (many calls) and single call (per-call overhead
  matters for the time-stretch, which calls the FFT per voice per block)
- Median of many warm runs, variance reported; target confidence interval ≤ 5%
- Native (Criterion), Node, and optionally Chrome, Firefox, Safari
- Time per call also reported as % of the 128-frame render quantum (≈ 2.7 ms at 48 kHz)

### 4. Decision criteria (proposal)

Gates (an option failing one is excluded):

- Accuracy targets above are met
- No allocation after plan creation; caller-provided buffers; works with the talc allocator
- License compatible with the project's licensing
  Compared:
- Performance (time per call)
- Wasm binary size added (after `wasm-opt` + gzip)
- Dependency footprint
- API fit (layout, normalization, inverse, Hann helpers)
- Maintenance cost
  `future-plans/simd-fft.md` prefers the library if it is within ~20% of a hand-written kernel,
  but also notes that minimal dependencies favour an own kernel. Proposed rule to resolve this:
  use the library if it passes all gates, is within 20% of the custom kernel, and adds at most
  S KB (gzipped) to the Wasm binary; otherwise use the custom kernel.

## Proposed targets (for discussion)

- Speed: ≥ 4× vs. the current scalar radix-2 for N = 1024–4096 (stretch 6–8×);
  N = 256 and N = 8192 measured and reported
- Render budget: time-stretch with V voices uses ≤ P% of the render quantum in the peak block
  (proposal: V = 16, P = 25%)

## Deliverables

1. Harness (Rust, native + Node) — first PR, no production change
2. Optional: browser test page — separate PR
3. Prototype kernel on an unmerged branch
4. Issue with results: numbers, binary sizes, stage/shuffle finding, recommendation

## Open questions for the maintainer

- Speed target and baseline: is ≥ 4× vs. the current scalar radix-2 the right measure?
- ε for the analyser output contract
- Realistic voice count V and budget P for the time-stretch
- Maximum acceptable binary size increase S
- Is a scalar fallback build still needed, given the Wasm build uses `+simd128`?
- Is a browser test page wanted in the repository?

## Terms

- **SIMD128:** WebAssembly's 128-bit vector extension; `f32x4` holds 4 float32 values.
- **Split layout (SoA):** real and imaginary parts in separate arrays.
- **DIT / bit reversal:** decimation-in-time FFT; needs the input reordered by mirrored index bits.
- **Post-twiddle:** step that turns an N/2-point complex FFT of packed real data into the N-point real spectrum.
- **Render quantum:** the 128-frame block an AudioWorklet processes per call.
- **TS-faithful:** analyser output matches the TypeScript `lib-dsp` FFT within tolerance.
- **Parseval check:** Σ|x|² = Σ|X|² / N; detects scaling errors.
