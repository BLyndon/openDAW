# SIMD kernel: optimisation steps and expected speed-up

How the prototype kernel (`src/options/simd/`) gets from the scalar baseline `dsp::rfft` to its measured
speed. Each step says what changes, why it is faster, and how much it is expected to gain.

The expected gains are **estimates from operation counts**, not measurements: each step was not measured
on its own. A per-step measurement (ablation) is listed at the end as an open task. The measured total is
in the last section.

## Starting point: `dsp::rfft`

- Real input of N samples, transformed as an M = N/2-point complex FFT plus a post-twist.
- Radix-2 decimation-in-time (DIT): bit reversal, then log2 M stages.
- Scalar f32, split re/im arrays, one shared twiddle table read with a stride (`k += table_step`).
- Post-twist and inverse pre-twist are scalar loops.

Work per call at N = 1024 (M = 512):

| Item                | Count                                   |
| ------------------- | --------------------------------------- |
| Bit reversal        | 1 pass over M values, data-dependent swaps |
| Butterfly passes    | 9 (log2 512)                            |
| Butterflies         | 9 × 256 = 2304, 10 flops each = 23 040 flops |
| Memory per butterfly| 4 loads, 4 stores, 2 strided twiddle loads |
| Twist               | M/2 scalar iterations                   |

## Step 1: real-input trick (N/2 complex + twist)

**What:** pack the N real samples as M = N/2 complex values `z[j] = x[2j] + i·x[2j+1]`, run an M-point
complex FFT, then separate the even and odd parts in a twist:
`X[k] = A/2 + U[k]·D`, with `A = Z[k] + conj Z[M−k]`, `D = Z[k] − conj Z[M−k]` and
`U[k] = −i·W^k/2`, `W = exp(−2πi/N)`.

**Why faster:** half the FFT size, half the work, and no wasted upper half of the spectrum.

**Expected gain:** none against `dsp::rfft`, which already does this. **About 2×** against the analyser and
against `signalsmith` used on one real channel. Report this gain separately from the SIMD gain.

## Step 2: radix-4 instead of radix-2

**What:** each stage splits a transform into four quarter-length ones. The 4-point DFT of `(a, b, c, d)`
needs no multiplications, because its twiddles are ±1 and ±i:

```
y0 = (a + c) + (b + d)
y1 = (a − c) − i(b − d)   then × w1
y2 = (a + c) − (b + d)   then × w2
y3 = (a − c) + i(b − d)   then × w3
```

`i·(x + iy) = −y + ix` is only a swap and a sign, so it is folded into the adds (`butterfly` in `kernel.rs`).

**Why faster:**

- **Fewer flops.** Each radix-4 butterfly costs 3 complex multiplies + 8 complex adds = 34 flops for
  4 points, against 4 radix-2 butterflies × 10 = 40 flops. At M = 512 (4 radix-4 stages and 1 radix-2
  stage): about 18 400 flops instead of 23 040, **−20 %**.
- **Half the passes over memory:** 5 instead of 9 at M = 512. Every pass loads and stores the whole
  array, so loads and stores drop by about 45 %.

**Expected gain:** **1.3–1.5×** (flops −20 %, memory traffic −45 %).

## Step 3: Stockham autosort, no bit reversal

**What:** every stage reads from one buffer and writes to the other (ping-pong), already putting values in
their final order. Stage `i` reads `work[(i + 1) % 2]` and writes `work[i % 2]` (`ping_pong`). The output
comes out in natural order.

Stage indexing (sub-transform length `L`, `stride = M / L`, `quarter = M / 4`):

```
read   a, b, c, d = x[q + stride·p + {0, 1, 2, 3}·quarter]
write  y[q + stride·(4p + r)]                       r = 0..3
```

**Why faster:**

- **No bit-reversal pass.** That pass is scalar, does data-dependent swaps with a poor access pattern and
  cannot be vectorised well. It takes roughly 10–15 % of a scalar radix-2 FFT.
- **Contiguous access in every stage.** That is what makes steps 4 and 5 possible.
- **Cost:** two work buffers of M complex values each, allocated once in `new`.

**Expected gain:** **1.1–1.2×**.

## Step 4: twiddle tables per stage, contiguous

**What:** each radix-4 stage of length `L` has its own table of `6 · L/4` floats:
`[w1.re | w1.im | w2.re | w2.im | w3.re | w3.im]`, with `w_k[p] = exp(−2πi·k·p/L)`. They are computed in f64
and stored as f32, as in the existing FFTs.

**Why faster:**

- In the stages with stride ≥ 4, each `p` uses one twiddle for all four lanes. It is broadcast once
  (`V4::splat`) outside the inner `q` loop.
- In the first stage, lanes run over `p`, so the twiddles of four consecutive `p` sit next to each other
  and come in with one vector load each.
- No strided gathers. In the reverted SIMD attempt (`7998a6b64`), gathering twiddles lane by lane was one
  of the two reasons it ran badly in the browser (see `analysis/findings.md` § 5).

**Expected gain:** small on its own (**about 1.05×** scalar). It is the precondition for step 5 to run at
full width.

## Step 5: `f32x4` butterflies on split re/im arrays

**What:** four butterflies per instruction. Real and imaginary parts sit in separate arrays, so one `v128`
holds four real parts or four imaginary parts of consecutive points. A complex multiply is
`(ac − bd) + i(ad + bc)`: 4 `f32x4.mul` and 2 add/sub, with no shuffles (`C4::mul`).

- Every data load and store is a `v128.load` / `v128.store`, never built lane by lane. In the reverted
  attempt, `im` was built lane by lane.
- No FMA (fused multiply-add), so wasm and the native `[f32; 4]` fallback compute the same bits (`v4.rs`).

**Why faster:** 4 lanes per arithmetic instruction, and 4× fewer loop iterations and address computations.

**Expected gain:** 4× in theory; **2.5–3.5×** in practice. Loads and stores, broadcasts and the transposes
from step 6 do not shrink by 4.

## Step 6: vectorising the first stage with a 4×4 transpose

**What:** in a Stockham DIF transform the first stage has stride 1. The four outputs of one butterfly go to
the neighbouring addresses `4p + 0..3`, so the "lanes run over `q`" scheme does not apply there. Instead,
the lanes run over four consecutive `p` (inputs are contiguous), and the four result vectors are
transposed before storing:

```
lane j of y_r  →  output 4(p + j) + r
t0 = (y0[0] y1[0] y0[1] y1[1])   t1 = (y0[2] y1[2] y0[3] y1[3])   shuffles <0,4,1,5> / <2,6,3,7>
t2, t3 likewise from y2, y3
o0 = (t0 lo, t2 lo) … o3 = (t1 hi, t3 hi)                          shuffles <0,1,4,5> / <2,3,6,7>
```

This costs 8 shuffles for re and 8 for im per 16 outputs. All later stages have stride ≥ 4 and need no
shuffles. This confirms the stage/shuffle finding of the baseline analysis: shuffles are needed at the
start, not the end.

**Why faster:** without the transpose, one of 5 stages would stay scalar. By Amdahl's law, one scalar stage
next to four 3× stages takes up almost half of the run time.

**Expected gain:** **1.3–1.5×** against a version with a scalar first stage.

## Step 7: skipping trivial twiddles

**What:** `p = 0` has all twiddles equal to 1, so its loop does no multiplications. The last radix-4 stage
(length 4) consists only of `p = 0`. The radix-2 stage that follows when log2 M is odd has no twiddles at
all.

**Why faster:** about one twiddled stage in five does no multiplications, plus one `p` group in every other
stage.

**Expected gain:** **1.05–1.1×**.

## Step 8: reading the real input in pairs inside the first stage

**What:** the source `Packed` reads 8 samples with two `v128.load`s and splits them into even and odd
lanes (shuffles `<0,2,4,6>` / `<1,3,5,7>`). That gives `re` and `im` of four `z[j]`. There is no separate
copy pass that would rearrange the input into re/im arrays.

**Expected gain:** **1.03–1.05×** (one pass over N floats saved).

## Step 9: vectorised twist with mirrored loads

**What:** `X[k]` and `X[M−k]` come from the same two input values:

```
X[k]   = A/2 + U[k]·D
X[M−k] = conj(A/2 − U[k]·D)
```

So the loop handles both at once. The partner block `M−k−3 … M−k` is read with one forward load and
reversed (shuffle `<3,2,1,0>`). Blocks start at `k = 1` and run up to `M/2` inclusive (M/8 iterations).
DC and Nyquist are computed separately from `Z[0]`: `X[0] = Re Z[0] + Im Z[0]` and
`X[M] = Re Z[0] − Im Z[0]`.

**Why faster:** the twist runs 4 lanes at a time and reads each value once instead of twice.

**Expected gain:** **1.08–1.12×** (the scalar twist takes roughly 10–15 % of `rfft`).

## Step 10: inverse without extra passes

**What:**

- **Swap trick.** `IDFT(x) = swap(DFT(swap(x)))`, where `swap` exchanges re and im. With split arrays,
  that swap just means passing the arrays the other way round, so the inverse reuses the forward stages
  and needs neither conjugation passes nor separate inverse tables.
- **Scaling folded into the pre-twist.** The pre-twist uses the same formula with `conj(U[k])`. The factor
  1/M (which, together with the factor 1/2 already in the twist, gives 1/N overall) is built into its table
  and its `half` factor, so there is no separate scaling pass.
- **Unpacking folded into the last stage.** The sink `Unpacked` writes the swapped result straight back
  into interleaved real samples (shuffles `<0,4,1,5>` / `<2,6,3,7>`).

**Expected gain:** **1.1–1.2×** on the inverse (2–3 passes over the data saved).

## Step 11: no bounds checks, everything inlined

**What:** `Source`/`Sink` are traits with monomorphised implementations (`Split`, `Packed`, `Unpacked`,
`ScaledMut`). Every stage is `#[inline(always)]`, so each combination compiles to a single straight loop.
Vector loads and stores go through raw pointers without bounds checks. Each public entry point checks the
buffer lengths once, and `debug_assert!` checks every access in the test build (`cargo test`).

**Why faster:** a bounds check in wasm is a compare and a branch per access. With 8–16 accesses per
butterfly, that is a noticeable share.

**Expected gain:** **1.1–1.2×**.

## Expected against measured

The steps compound. As a rough product of the middle values against `dsp::rfft`:

| Step                     | Expected |
| ------------------------ | -------- |
| 2 radix-4                | 1.4      |
| 3 Stockham               | 1.15     |
| 4 contiguous twiddles    | 1.05     |
| 5 `f32x4`                | 3.0      |
| 6 vectorised first stage | (included in 5; without it 5 would reach only about 2×) |
| 7 trivial twiddles       | 1.07     |
| 8 reading input in pairs | 1.04     |
| 9 vectorised twist       | 1.1      |
| 11 no bounds checks      | 1.15     |
| **Product**              | **≈ 7×** |

The steps overlap, so the true product is lower; **5–7×** is a realistic expectation.

Measured in Node (V8 13.6, Apple M1, 2026-11-21, forward, throughput, median µs per call). The machine was
heavily loaded and the tree dirty, so these are **preliminary numbers**:

| N    | `rfft` | `realfft` | `simd` | vs `rfft` | vs `realfft` |
| ---- | ------ | --------- | ------ | --------- | ------------ |
| 1024 | 7.03   | 1.49      | 0.92   | **7.6×**  | 1.6×         |
| 4096 | 32.9   | 8.50      | 5.60   | **5.9×**  | 1.5×         |

The measured gain lies within the expected range, above the plan's target (≥ 4× for N = 1024–4096). At
N = 4096 it is lower than at 1024. The likely cause is that the 4096 working set (2 × 2 × 2048 floats =
32 KB plus tables) no longer fits as comfortably in L1 as the 1024 one does.

The full complex variant `simd-complex` (for `signalsmith`, two real channels per call) is 9.6× (N = 1024)
and 5.3× (N = 4096) faster than `signalsmith`.

## Open points

- **Ablation:** measure each step on its own (for example radix-2 Stockham with SIMD, radix-4 without SIMD,
  scalar first stage), so the estimates above are replaced by numbers.
- **Inverse at N = 4096** is slower than the forward (7.41 vs 5.60 µs). Suspects: the last stage that
  interleaves the output (`Unpacked`), and the access to the input from both ends in the pre-twist. Not yet
  examined.
- **Further steps not tried:**
  - radix-8 for the last stage when log2 M is odd, instead of radix-2 (one pass fewer)
  - fusing the last stage with the twist, which saves one pass over M values (expected 1.05–1.1×)
- **Browsers:** Chrome, Firefox and Safari through the browser page are still to be measured. Of particular
  interest is the audio-thread tier, which slowed down the reverted attempt.
- **Binary size:** the `simd` stub in `size/` is still missing.
