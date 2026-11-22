# SIMD FFT: library or own kernel?

**Question:** the engine needs a faster FFT for WebAssembly (f32, real input, N = 256–16384). Should it depend on
`realfft`/`rustfft`, or use a small kernel of its own? The own kernel is `simd-o1o4`, the round 2 prototype in
`crates/fft-bench`: the round 1 prototype `simd` plus the outlook items O1 and O4, with the same bits as `simd`.
`future-plans/simd-fft.md` asks for this comparison before deciding.

**Status, 2026-11-22:**

- Node is measured, all four columns below in one run.
- Chrome forward is measured for `realfft`, `simd` and `rfft`; `simd-o1o4` only on the stages page, without `realfft`.
- Firefox, Safari and the browser inverse are still missing.

The numbers are preliminary: one machine (Apple M1), measured under load, from a tree that was not yet committed.

## Results so far

| Criterion                                              | `realfft`               | `simd-o1o4`        | `simd` (round 1)   | `rfft` (today, scalar) | Threshold                                                 |
| ------------------------------------------------------ | ----------------------- | ------------------ | ------------------ | ---------------------- | --------------------------------------------------------- |
| Forward, N = 1024 / 4096 (Node 24)                     | 1.45 / 6.44 µs          | 0.76 / 3.37 µs     | 0.84 / 4.00 µs     | 6.69 / 32.5 µs         | –                                                         |
| Inverse, N = 1024 / 4096 (Node 24)                     | 1.33 / 6.09 µs          | 0.89 / 3.86 µs     | 0.84 / 3.77 µs     | 7.13 / 31.4 µs         | –                                                         |
| Forward, N = 1024 / 4096 (Chrome 156)                  | 1.42 / 6.23 µs          | not in this run    | 0.84 / 3.85 µs     | 6.85 / 31.6 µs         | –                                                         |
| Speed-up vs. `rfft`, worst of N = 1024–16384 (Node)    | 4.4×                    | 7.7×               | 7.4×               | 1×                     | ≥ 4× for N = 1024–16384 (proposal)                        |
| `realfft` time ÷ own kernel, all sizes (Node, fwd+inv) | –                       | 1.49–1.92          | 1.56–1.76          | –                      | ≤ 1.2 → prefer the library, if it passes all gates (plan) |
| `realfft` time ÷ `simd` time (Chrome 156, forward)     | –                       | not in this run    | 1.54–1.74          | –                      | ≤ 1.2 → prefer the library, if it passes all gates (plan) |
| Accuracy gates                                         | pass                    | pass               | pass               | pass                   | rel. RMS ≤ 2× `rfft`, round trip and contract ≤ 1e-5      |
| Allocation after plan creation                         | none                    | none               | none               | none                   | none                                                      |
| Wasm size added (wasm-opt + gzip)                      | 172.6 kB                | 11.2 kB            | 9.5 kB             | 4.5 kB                 | ≤ S kB (open)                                             |
| Links `no_std` with the engine                         | **no**                  | yes                | yes                | yes                    | required                                                  |
| Licence                                                | MIT / MIT OR Apache-2.0 | AGPL-3.0 (project) | AGPL-3.0 (project) | AGPL-3.0 (project)     | –                                                         |

Node rows: one run, 2026-11-22 20:26 UTC, module sha256 328e87ebc2e9 (`results/2026-11-22/node-candidates.md`).
Chrome rows: an earlier run on Chrome 156; Chrome 157 times `simd-o1o4` only on the stages page (0.72 / 3.30 µs forward).

- **Library vs. own kernel:** `realfft` is not within 20 % of `simd-o1o4` at any size; in Node it takes 1.5–1.9× as
  long. It also fails the `no_std` gate as it stands and adds about 35 % to a 490 kB engine binary.
- **Round 2 vs. round 1:** `simd-o1o4` is 10–19 % faster than `simd` in the forward direction at N = 1024–8192 and costs
  1.7 kB more; the inverse is unchanged within the noise.
- **Is it worth it?** From the Node render-budget model:
  - time-stretch with 16 regions, `rfft` → `realfft`: from 9.1 % to 1.9 % of a render quantum (earlier run);
  - the Convolver's worst case: 11.9 % with `rfft`, 2.7 % with `realfft`, 1.6 % with `simd-o1o4`.

  The analyser does not need a faster FFT. The time-stretch has not been modelled with `simd-o1o4` yet.

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
- `simd-o1o4` next to `realfft` in Chrome, Firefox and Safari (the decision page).
- `simd-o1o4` in the time-stretch budget model.
- A rerun on a quiet machine from a committed tree.

## Where to look

| What                                                       | Where                                                                               |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Run the comparison yourself, with all criteria on one page | `cd crates/fft-bench && node web/serve.mjs`, then the decision page and **Run all** |
| What the analysis of the existing FFTs found               | [findings.md](findings.md)                                                          |
| How the prototype kernel works, step by step               | `crates/fft-bench/docs/simd-kernel.md`                                              |
| How to take a full measurement run                         | `crates/fft-bench/docs/runbook.md`                                                  |
| Raw results (kept locally, not in the repository)          | `analysis/results/<date>/`                                                          |
