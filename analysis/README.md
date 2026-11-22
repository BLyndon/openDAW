# SIMD FFT: library or own kernel?

**Question:** the engine needs a faster FFT for WebAssembly (f32, real input, N = 256–16384). Should it depend on
`realfft`/`rustfft`, or use a small kernel of its own (`simd`, a prototype in `crates/fft-bench`)?
`future-plans/simd-fft.md` asks for this comparison before deciding.

**Status, 2026-11-22:**

- Node is measured.
- Chrome forward is measured.
- Firefox, Safari and the browser inverse are still missing.

The numbers are preliminary: one machine (Apple M1), measured under load, from a tree that was not yet committed.

## Results so far

| Criterion                                            | `realfft`               | `simd`             | `rfft` (today, scalar) | Threshold                                                 |
| ---------------------------------------------------- | ----------------------- | ------------------ | ---------------------- | --------------------------------------------------------- |
| Forward, N = 1024 / 4096 (Chrome 156)                | 1.42 / 6.23 µs          | 0.84 / 3.85 µs     | 6.85 / 31.6 µs         | –                                                         |
| Forward, N = 1024 / 4096 (Node 24)                   | 1.49 / 8.50 µs          | 0.92 / 5.60 µs     | 7.03 / 32.9 µs         | –                                                         |
| Speed-up vs. `rfft`, worst of N = 1024–4096 (Chrome) | 4.8×                    | 8.2×               | 1×                     | ≥ 4× for N = 1024–16384 (proposal)                        |
| `realfft` time ÷ `simd` time (Chrome, forward)       | 1.54–1.74, all sizes    | –                  | –                      | ≤ 1.2 → prefer the library, if it passes all gates (plan) |
| Accuracy gates                                       | pass                    | pass               | pass                   | rel. RMS ≤ 2× `rfft`, round trip and contract ≤ 1e-5      |
| Allocation after plan creation                       | none                    | none               | none                   | none                                                      |
| Wasm size added (wasm-opt + gzip)                    | 172.6 kB                | 9.5 kB             | 4.5 kB                 | ≤ S kB (open)                                             |
| Links `no_std` with the engine                       | **no**                  | yes                | yes                    | required                                                  |
| Licence                                              | MIT / MIT OR Apache-2.0 | AGPL-3.0 (project) | AGPL-3.0 (project)     | –                                                         |

- **Library vs. own kernel:** `realfft` is not within 20 % of `simd` at any size; it takes 1.5–1.7× as long. It
  also fails the `no_std` gate as it stands and adds about 35 % to a 490 kB engine binary.
- **Is it worth it?** From the Node render-budget model, `rfft` → `realfft`:
  - time-stretch with 16 regions goes from 9.1 % to 1.9 % of a render quantum;
  - the Convolver's worst case goes from 12.2 % to 2.6 %.

  The analyser does not need a faster FFT. `simd` has not been put through this model yet.

- **Why the earlier SIMD attempt failed, and what is different now:** [findings.md](findings.md) § 5.

## Open for the maintainer

1. **Thresholds:**
   - S (maximum added binary size);
   - V and P (time-stretch regions and their share of the render quantum; proposed: 16 and 25 %);
   - whether ≥ 4× against `rfft` is the right speed target.
2. **Policy:** does "no third-party DSP" allow an exception for an FFT, and would a `no_std` build of the library
   count?
3. **Scalar fallback:** is a scalar build still needed, given the engine builds with `+simd128`?

## Still to measure

- Firefox and Safari, plus the browser inverse, steps and budget (the page's **Run all**).
- The speed-up at N = 8192 and 16384, which the target now covers.
- `simd` in the render-budget model.
- A rerun on a quiet machine from a committed tree.

## Where to look

| What                                                       | Where                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| Run the comparison yourself, with all criteria on one page | `cd crates/fft-bench && node web/serve.mjs`, then **Run all** |
| What the analysis of the existing FFTs found               | [findings.md](findings.md)                                    |
| How the prototype kernel works, step by step               | `crates/fft-bench/docs/simd-kernel.md`                        |
| How to take a full measurement run                         | `crates/fft-bench/docs/runbook.md`                            |
| Raw results (kept locally, not in the repository)          | `analysis/results/<date>/`                                    |
