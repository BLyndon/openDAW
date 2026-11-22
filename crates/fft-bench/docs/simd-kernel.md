# SIMD kernel: from the textbook FFT to the prototype

How the prototype kernel (`src/options/simd/`) gets its speed. Part 1 starts from the textbook FFT and adds one
optimisation per step. Appendices A and B hold the theory Part 1 relies on, for readers who want to refresh it.

## Overview

| Step | Optimisation                                                       | What it changes                 |
| ---- | ------------------------------------------------------------------ | ------------------------------- |
| 0    | Baseline: $N$-point complex radix-2 FFT on real input (`analyser`) | –                               |
| 1    | Real-input trick: $N/2$-point complex FFT + twist (`dsp::rfft`)    | flops halved                    |
| 2    | Radix-4 stages                                                     | fewer flops, half the passes    |
| 3    | Skipping trivial twiddles                                          | fewer flops                     |
| 4    | Stockham autosort                                                  | no bit-reversal pass            |
| 5    | Twiddle tables per stage                                           | fewer, contiguous twiddle loads |
| 6    | `f32x4` butterflies in the stages with stride ≥ 4                  | 4 butterflies per instruction   |
| 7    | 4×4 transpose for the first stage                                  | first stage vectorised          |
| 8    | Reading the real input in pairs                                    | no packing pass                 |
| 9    | Vectorised twist                                                   | twist vectorised                |
| 10   | Unchecked vector access                                            | no bounds checks                |

**Big O does not change.** From step 0 on, every version is $\Theta(N \log N)$. The steps change constant factors and
lower-order terms, and Big O hides both. So each step counts instead:

- **flops:** real additions, subtractions and multiplications, the standard measure for FFT algorithms
  ([A.6](#a6-counting-cost));
- **passes:** how often the whole working array is read and written;
- from step 6 on, **instructions:** one `f32x4` instruction does 4 flops; a shuffle counts as one instruction.

All counts are for the forward transform at **$N = 1024$** real samples (from step 1 on: $M = N/2 = 512$ complex
values). They are counted by hand from the code. **The expected factors are estimates from these counts, not
measurements**.

## Part 1: from the baseline to the prototype

### Step 0: baseline

**What.** The textbook FFT ([A.2](#a2-radix-2-butterflies-dit-and-dif)). The real input becomes $N$ complex values
with imaginary part 0. A bit-reversal pass follows, then $`\log_2 N`$ radix-2 stages, in place. All stages share one
twiddle table, read with a stride (`k += table_step`). Scalar f32 on split re/im arrays. This is the FFT of
`dsp::analyser` (harness option `analyser`).

**Count.** 10 stages × 512 butterflies = 5 120 butterflies. Each costs one complex multiply (6 flops) and two
complex additions (4 flops): **51 200 flops**, the classic $`5N\log_2 N`$. **11 passes** over $N$ values: bit
reversal and 10 stages.

**Cost.** $\Theta(N \log N)$, leading term $`5N\log_2 N`$.

**Reference.** Cooley & Tukey 1965.

### Step 1: real-input trick

**What.** Pack the $N$ real samples as $M = N/2$ complex values $z[j] = x[2j] + i\,x[2j+1]$, run an $M$-point
complex FFT, then separate the spectra of the even and odd samples in a twist ([A.5](#a5-real-input-packing-and-twist)). No
lane carries a zero imaginary part any more, and the mirrored upper half of the spectrum is not computed. This
step gives `dsp::rfft`, up to one detail (below).

**Count.**

- FFT: 9 stages × 256 butterflies × 10 flops = 23 040 flops
- Twist: 256 iterations × 18 flops = 4 608 flops
- Total **27 648 flops** (51 200 before)
- **12 passes**, over an array half as large: packing, bit reversal, 9 stages, twist

`dsp::rfft` as written multiplies every sine by a sign for the inverse (`sign * self.sin[k]`), also in the
forward. That is one more flop per butterfly: 9 × 256 × 11 + 4 608 = **29 952 flops**. The later steps count from
the 27 648 of the clean version.

**Cost.** $\Theta(N \log N)$. The leading term drops from $`5N\log_2 N`$ to
$`5 \cdot \frac{N}{2} \log_2 \frac{N}{2} \approx 2.5\,N\log_2 N`$. The twist adds a $\Theta(N)$ term.

**Expected.** **1.85×** from the flops, **1.71×** for `rfft` as written. Measured in Node at $N = 1024$,
`analyser` → `rfft`: 11.8 → 6.96 µs, **1.7×** (`analysis/results/2026-11-21/node.md`). This is the only step with
its own measurement.

**Reference.** Sorensen et al. 1987.

### Step 2: radix-4

**What.** Each stage splits a transform into four quarter-length ones instead of two halves
([A.3](#a3-radix-4)). The 4-point DFT inside needs no multiplications, so only three twiddle multiplies remain per
four points. $M = 512 = 4^4 \cdot 2$ gives 4 radix-4 stages and one radix-2 stage. The input still needs one permutation
pass.

**Count.**

- Radix-4 butterfly: 8 complex additions (16 flops) + 3 complex multiplies (18 flops) = 34 flops for 4 points
- 4 stages × 128 butterflies × 34 flops = 17 408 flops, plus the radix-2 stage: 256 × 10 = 2 560 flops
- FFT 19 968 flops (23 040 before), total with twist **24 576 flops**
- **8 passes** (12 before): packing, permutation, 5 stages, twist

**Cost.** $\Theta(N \log N)$. One radix-4 butterfly does the work of four radix-2 butterflies over two stages, for
34 instead of 40 flops. The leading term drops from $`5M\log_2 M`$ to $`4.25\,M\log_2 M`$ (−15 %). The number of
stages drops from $`\log_2 M`$ to about $`\log_4 M = \frac{1}{2}\log_2 M`$, so the passes halve.

**Expected.** 1.13× from the flops, up to 1.5× from the passes: **1.2–1.4×**.

**Reference.** Van Loan 1992; Duhamel & Vetterli 1990.

### Step 3: skipping trivial twiddles

**What.** In every radix-4 stage the group $p = 0$ has all twiddles equal to 1, so its loop has no multiplies. The
radix-2 stage has no twiddles at all. The kernel does not split off $p = 0$ in the first stage, where it is a
single butterfly (step 7 handles four $p$ at a time).

**Count.**

- $p = 0$ butterflies in the three later radix-4 stages: 4 + 16 + 64 = 84, each 18 flops cheaper: −1 512 flops
- Radix-2 stage: 256 × 6 = −1 536 flops
- Total **21 528 flops** (24 576 before)

At $N = 1024$ the last radix-4 stage has length 8, so half its butterflies have $p = 0$. When $`\log_2 M`$ is even,
the last radix-4 stage has length 4 and consists of $p = 0$ only.

**Cost.** $\Theta(N \log N)$, leading term unchanged. The $p = 0$ butterflies of a stage number its stride, and the
strides (1, 4, 16, 64) add up to less than $M/3$. The radix-2 stage has $M/2$ butterflies. Both savings are
$\Theta(N)$, so their share falls as $N$ grows.

**Expected.** **1.14×** from the flops.

**Reference.** Duhamel & Vetterli 1990.

### Step 4: Stockham autosort

**What.** Each stage reads one buffer and writes the other (ping-pong) and puts the values into their final order
as it goes ([A.4](#a4-stockham-autosort)). The output comes out in natural order, so the permutation pass goes.
Stage `i` reads `work[(i + 1) % 2]` and writes `work[i % 2]` (`ping_pong`). The kernel uses the
decimation-in-frequency form: twiddles multiply after the 4-point DFT. The flop count is the same as for DIT.

**Count.** Flops unchanged (21 528). **7 passes** (8 before). Two work buffers of $M$ complex values each,
2 × 512 × 8 bytes = 8 KB, allocated once in `new`.

**Cost.** $\Theta(N \log N)$, leading term unchanged. One $\Theta(N)$ pass is gone, and it is the worst one: data-dependent
swaps at scattered addresses, which cannot be vectorised well. Every stage now reads and writes contiguous
blocks, which steps 5–7 need.

**Expected.** **1.1–1.2×** (estimate; bit reversal takes roughly 10–15 % of a scalar radix-2 FFT).

**Reference.** Stockham 1966; Cochran et al. 1967; Van Loan 1992.

### Step 5: twiddle tables per stage

**What.** Each radix-4 stage of length $L$ gets its own table of $6 \cdot L/4$ floats,
`[w1.re | w1.im | w2.re | w2.im | w3.re | w3.im]` with $`w_k[p] = e^{-2\pi i\,kp/L}`$, computed in f64 and stored
as f32. The loop over the twiddle group $p$ is outside, the loop over the butterflies $q$ that share it is inside.
So a twiddle is loaded once per $p$ from a contiguous table, not once per butterfly with a stride.

**Count.** Flops unchanged. Twiddle loads: about 2 570 strided → about 1 000 contiguous. Tables:
6 · (128 + 32 + 8 + 2) = 1 020 floats, about 4 KB.

**Cost.** $\Theta(N \log N)$, flops unchanged. Twiddle loads drop from $\Theta(N \log N)$, one per butterfly, to
$\Theta(N)$: the tables hold $6\,(M/4 + M/16 + \dots) \approx 2M$ floats, and each is loaded once. This is the only cost item in this
document whose order changes.

**Expected.** **About 1.05×** in scalar code (estimate). The step mainly prepares step 6:

- In the stages with stride ≥ 4, one twiddle is broadcast to all four lanes (`V4::splat`) outside the inner loop.
- In the first stage, the twiddles of four neighbouring $p$ come in with one vector load.
- The reverted SIMD attempt (`7998a6b64`) gathered twiddles lane by lane. That was one of the two reasons it ran
  badly in the browser (`analysis/findings.md` § 5).

**Reference.** Van Loan 1992.

### Step 6: `f32x4` butterflies

**What.** Four butterflies per instruction ([B.1](#b1-vectors-and-lanes)). Real and imaginary parts sit in
separate arrays, so one `v128` holds four real parts or four imaginary parts of neighbouring points. A complex
multiply is 4 `f32x4.mul` and 2 add/sub, with no shuffles (`C4::mul`, [B.4](#b4-interleaved-against-split)).
This works wherever four neighbouring butterflies share a twiddle: in the stages with stride ≥ 4 and in the
radix-2 stage. The first stage (stride 1) stays scalar in this step.

- Every data access is one `v128.load` or `v128.store`, never built lane by lane.
- No FMA, so the wasm build and the native `[f32; 4]` fallback compute the same bits ([B.5](#b5-no-fma)).

**Count.**

- First stage: 4 352 scalar flops
- Stages 2–4 and radix-2 stage: 12 568 flops → 3 142 instructions
- Twist: 4 608 scalar flops
- Total **12 102 instructions** (21 528 before)

**Cost.** $\Theta(N \log N)$. The vectorised part, $\Theta(N \log N)$, shrinks by 4. The scalar rest (first stage
and twist) is only $\Theta(N)$, so the gain tends to 4× as $N$ grows. At $N = 1024$, though, the scalar rest is
42 % of the work, and Amdahl's law ([B.6](#b6-amdahls-law)) limits the gain to $1/(0.42 + 0.58/4) = 1.78$.

**Expected.** **1.8×** from the instructions.

**Reference.** WebAssembly SIMD (Core Specification 2.0); Amdahl 1967.

### Step 7: first stage with a 4×4 transpose

**What.** In the first stage the four outputs of a butterfly go to the neighbouring addresses $4p, \dots, 4p + 3$,
so the lanes cannot run over $q$. Instead they run over four neighbouring $p$: the inputs are contiguous, and so are the
twiddles (step 5). The four result vectors are transposed before they are stored:

```
lane j of y_r  →  output 4(p + j) + r
t0 = (y0[0] y1[0] y0[1] y1[1])   t1 = (y0[2] y1[2] y0[3] y1[3])   shuffles <0,4,1,5> / <2,6,3,7>
t2, t3 likewise from y2, y3
o0 = (t0 lo, t2 lo)   o1 = (t0 hi, t2 hi)   o2 = (t1 lo, t3 lo)   o3 = (t1 hi, t3 hi)   shuffles <0,1,4,5> / <2,3,6,7>
```

That is 8 shuffles for re and 8 for im per 16 outputs. All later stages have stride ≥ 4 and need no shuffles.
This confirms the stage/shuffle finding of the baseline analysis: the shuffles are needed at the start, not at
the end.

**Count.** First stage: 4 352 scalar flops → 1 088 instructions + 512 shuffles = 1 600. Total **9 350
instructions** (12 102 before).

**Cost.** $\Theta(N \log N)$. The $\Theta(N)$ scalar rest of step 6 shrinks to about a quarter, plus $\Theta(N)$
shuffles.

**Expected.** **1.3×** from the instructions.

**Reference.** `transpose` in `kernel.rs`; shuffle semantics in the WebAssembly Core Specification 2.0.

### Step 8: reading the real input in pairs

**What.** The first stage reads the real input directly. The source `Packed` loads 8 samples with two `v128.load`
and splits them into even and odd lanes (shuffles `<0,2,4,6>` / `<1,3,5,7>`). That gives `re` and `im` of four
`z[j]`, and the packing pass from step 1 goes. Sources and sinks are traits with monomorphised implementations
(`Split`, `Packed`, `Unpacked`, `ScaledMut`), and every stage is `#[inline(always)]`. So each combination compiles
to one loop without calls.

**Count.** +256 shuffles (2 for each of the 128 vector loads of complex values): **9 606 instructions**.
**6 passes** (7 before).

**Cost.** $\Theta(N \log N)$. One $\Theta(N)$ pass is gone. The instruction count rises a little; the gain is memory traffic.

**Expected.** **1.03–1.05×** (estimate).

**Reference.** `Packed` in `kernel.rs`.

### Step 9: vectorised twist

**What.** $X[k]$ and $X[M-k]$ come from the same two values $Z[k]$ and $Z[M-k]$
([A.5](#a5-real-input-packing-and-twist)):

```math
X[k] = \tfrac{1}{2} A + U[k]\, D, \qquad X[M-k] = \overline{\tfrac{1}{2} A - U[k]\, D}
```

One iteration handles $k, \dots, k+3$ and their partners $M-k, \dots, M-k-3$. The partner block is read with one
forward load and reversed (shuffle `<3,2,1,0>`). $k$ runs from 1 to $M/2$ in blocks of four, $M/8 = 64$
iterations. DC and Nyquist come from $Z[0]$ on their own: $X[0] = \mathrm{Re}\,Z[0] + \mathrm{Im}\,Z[0]$ and
$X[M] = \mathrm{Re}\,Z[0] - \mathrm{Im}\,Z[0]$.

**Count.** Twist: 4 608 scalar flops → 1 024 instructions + 256 shuffles = 1 280. Total **6 278 instructions**
(9 606 before).

**Cost.** $\Theta(N \log N)$. A $\Theta(N)$ term shrinks to about a quarter.

**Expected.** **1.5×** from the instructions.

**Reference.** Sorensen et al. 1987.

### Step 10: unchecked vector access

**What.** Rust checks every slice index at run time ([B.7](#b7-bounds-checks)). The kernel loads and stores its
data through raw pointers instead (`V4::load` / `V4::store`). `RealFft::forward` and `RealFft::inverse` check the
buffer lengths once per call, and `debug_assert!` still checks every access in the test build (`cargo test`). A
few scalar reads keep their check: the twiddles of the stages with stride ≥ 4 (read once per $p$, then `splat`)
and the DC and Nyquist bins, about 240 per call.

**Count.** Instructions and passes unchanged. About 3 400 of the 3 600 memory accesses per call each lose a
compare and a branch.

**Cost.** $\Theta(N \log N)$, a constant per access.

**Expected.** **1.1–1.2×** (estimate).

**Reference.** `V4::load` / `V4::store` in `v4.rs`.

### Expected against measured

| Step | Flops / instructions    | Passes            | Expected factor of the step        |
| ---- | ----------------------- | ----------------- | ---------------------------------- |
| 0    | 51 200                  | 11 ($N$ values)   | –                                  |
| 1    | 27 648 (`rfft`: 29 952) | 12 ($N/2$ values) | 1.85 (`rfft`: 1.71; measured: 1.7) |
| 2    | 24 576                  | 8                 | 1.2–1.4                            |
| 3    | 21 528                  | 8                 | 1.14                               |
| 4    | 21 528                  | 7                 | 1.1–1.2                            |
| 5    | 21 528                  | 7                 | 1.05                               |
| 6    | 12 102                  | 7                 | 1.8                                |
| 7    | 9 350                   | 7                 | 1.3                                |
| 8    | 9 606                   | 6                 | 1.03–1.05                          |
| 9    | 6 278                   | 6                 | 1.5                                |
| 10   | 6 278                   | 6                 | 1.1–1.2                            |

From step 1 (`rfft`) to step 10 (`simd`), three ways to estimate the gain:

- **Instructions:** 29 952 (`rfft` as written) → 6 278, **4.8×**.
- **Product of the middle factors of steps 2–10:** about **7.5×**. The steps overlap, so this overestimates.
- **Memory accesses** (data and twiddle loads and stores): about 29 600 → 3 600, **about 8×**.

Measured snapshot from the first Node run (V8 13.6, Apple M1, 2026-11-21, forward, throughput, median µs per
call), taken on a heavily loaded machine from a dirty tree. Current numbers, including the browsers, are in
`analysis/README.md`.

| N    | `rfft` | `realfft` | `simd` | vs `rfft` | vs `realfft` |
| ---- | ------ | --------- | ------ | --------- | ------------ |
| 1024 | 7.03   | 1.49      | 0.92   | **7.6×**  | 1.6×         |
| 4096 | 32.9   | 8.50      | 5.60   | **5.9×**  | 1.5×         |

The measured gain lies closer to the memory-access count than to the instruction count. In scalar code every
flop comes with loads, stores, index arithmetic and bounds checks, and the instruction count leaves them out. It
is above the ≥ 4× target at both sizes shown (the target covers $N = 1024$ to $16384$; the decision page shows
all sizes). Why the gain is lower at $N = 4096$ has not been examined. One candidate is cache behaviour: the work
buffers alone take 2 × 2 × 2048 floats = 32 KB.

The full complex variant `simd-complex` (for `signalsmith`, two real channels per call) is 9.6× ($N = 1024$) and
5.3× ($N = 4096$) faster than `signalsmith`.

## Inverse

The inverse reuses the forward stages, with three tricks:

- **Swap trick.** $\mathrm{swap}$ exchanges re and im, so $\mathrm{swap}(z) = i\,\overline{z}$. It follows that
  $\mathrm{swap}(\mathrm{DFT}(\mathrm{swap}(x))) = \overline{\mathrm{DFT}(\overline{x})}$, the unscaled inverse DFT.
  With split arrays, the swap just means passing the arrays the other way round. The inverse needs no conjugation
  passes and no stage tables of its own; only the pre-twist has its own table (next point).
- **Scaling folded into the pre-twist.** The pre-twist uses the same formula with $\overline{U[k]}$. The factor
  $1/M$ (with the factor $1/2$ already in the twist: $1/N$ overall) is built into its table and its `half` factor,
  so there is no separate scaling pass.
- **Unpacking folded into the last stage.** The sink `Unpacked` writes the swapped result straight back into
  interleaved real samples (shuffles `<0,4,1,5>` / `<2,6,3,7>`).

**Expected.** **1.1–1.2×** on the inverse (2–3 passes saved, estimate).

## Open points

- **Ablation:** measure each step on its own (for example radix-2 Stockham with SIMD, radix-4 without SIMD, a
  scalar first stage), so the estimates above are replaced by numbers.
- **Inverse at $N = 4096$** is slower than the forward (7.41 vs 5.60 µs). Suspects: the last stage that interleaves
  the output (`Unpacked`), and the access to the input from both ends in the pre-twist. Not yet examined.
- **Further steps not tried:**
  - radix-8 for the last stage when $`\log_2 M`$ is odd, instead of radix-2 (one pass fewer)
  - fusing the last stage with the twist, which saves one pass over $M$ values (expected 1.05–1.1×)
- **Browsers:** Chrome forward is measured (8.2× against `rfft`); Firefox, Safari and the browser inverse are
  still to come. The page times in a Worker; the audio-thread tier that slowed down the reverted attempt is not
  measured directly.

## Appendix A: FFT basics

Notation: $`W_L = e^{-2\pi i/L}`$ is the $L$-th root of unity, and $`W = W_N`$.

### A.1 From the DFT to the FFT

**Why.** The DFT of $N$ values is

```math
X[k] = \sum_{n=0}^{N-1} x[n]\, W^{nk}
```

Computed directly, that is $N$ outputs × $N$ terms: $\Theta(N^2)$. Much of this work repeats: $W^{nk}$ takes only
$N$ different values, so the same products turn up in many outputs. The FFT computes each of them once.

**How it works.** Split the sum into even and odd $n$. Since $`W_N^2 = W_{N/2}`$, each half is itself a DFT of
half the length:

```math
X[k] = \underbrace{\sum_{m=0}^{N/2-1} x[2m]\, W_{N/2}^{mk}}_{E[k]}
     + W^k \underbrace{\sum_{m=0}^{N/2-1} x[2m+1]\, W_{N/2}^{mk}}_{O[k]}
```

$E$ and $O$ repeat with period $N/2$, and $`W^{k + N/2} = -W^k`$. So the second half of the output needs no new
DFT, only the other sign:

```math
X[k] = E[k] + W^k\, O[k], \qquad X[k + N/2] = E[k] - W^k\, O[k], \qquad k = 0, \dots, N/2 - 1
```

**Gain.** Two DFTs of half the length plus $N/2$ combinations: $T(N) = 2\,T(N/2) + \Theta(N)$. Applied again to
$E$ and $O$, down to length 1, this gives $`\log_2 N`$ levels of $\Theta(N)$ work: $\Theta(N \log N)$. At
$N = 1024$ that is about $10^4$ instead of $10^6$ complex operations. This is the only change of order in this
document.

Big O drops constant factors: $`5N\log_2 N`$ and $`1.25\,N\log_2 N`$ are both $\Theta(N \log N)$. That is why
Part 1 counts operations instead.

### A.2 Radix-2: butterflies, DIT and DIF

**Why.** A.1 is a recursion. Written out as $`\log_2 N`$ stages, it runs as plain loops over one array, without
calls and without temporary arrays.

**How it works.** One combination from A.1 is a **butterfly**: two inputs, one **twiddle** factor $w$, two
outputs, $(a, b) \mapsto (a + w b,\ a - w b)$. That is one complex multiply and two complex additions, 10 flops.
Each stage does $N/2$ butterflies. The recursion can split the input or the output:

- **DIT** (decimation in time) splits the input into even and odd samples, as in A.1. Twiddles multiply before the
  addition. The input must be reordered first: the first split sorts by bit 0 of the index, the next by bit 1,
  and so on. The result is **bit-reversed order**. For $N = 8$, index 1 (binary 001) moves to position 4 (binary
  100).
- **DIF** (decimation in frequency) splits the output into even and odd bins. Pairing $n$ with $n + N/2$:

```math
X[2k] = \sum_{n=0}^{N/2-1} \big(x[n] + x[n + N/2]\big)\, W_{N/2}^{nk}, \qquad
X[2k+1] = \sum_{n=0}^{N/2-1} \big(x[n] - x[n + N/2]\big)\, W^n\, W_{N/2}^{nk}
```

Here twiddles multiply after the addition. The input stays in natural order; in place, the output comes out
bit-reversed.

**Gain.** Both forms need the same flops. DIF reads its inputs at the fixed distance $N/2$, so in contiguous
blocks. The kernel uses DIF (A.4).

### A.3 Radix-4

**Why.** Radix-2 spends one general complex multiply per butterfly, 4 per 4 points over two stages. Part of
these twiddles is a trivial factor: $`W_L^{p + L/4} = -i\,W_L^p`$. Radix-2 multiplies it in as part of a general
complex multiply. Radix-4 merges two radix-2 stages into one and pulls these factors out. They become the
$\pm 1, \pm i$ of a 4-point DFT, which cost nothing, and only 3 general multiplies per 4 points remain. Merging
also halves the number of stages, and with it the passes over memory.

**How it works.** Like DIF in A.2, but with four classes instead of two. For a transform of length $L$, split the
output into $k = 4k' + r$ and the input into quarters $n = p + mL/4$, with $r, m \in \{0, 1, 2, 3\}$. Since
$`W_L^{(mL/4)(4k'+r)} = W_4^{mr} = (-i)^{mr}`$:

```math
X[4k' + r] = \sum_{p=0}^{L/4-1}
  \Big[\underbrace{\sum_{m=0}^{3} x[p + mL/4]\,(-i)^{mr}}_{\text{4-point DFT}}\Big]\,
  \underbrace{W_L^{pr}}_{\text{twiddle}}\; W_{L/4}^{pk'}
```

Read from the inside out:

1. **4-point DFT** of $a, b, c, d = x[p],\ x[p + L/4],\ x[p + L/2],\ x[p + 3L/4]$. Its factors are only
   $1, -i, -1, i$:

   ```math
   \begin{aligned}
   y_0 &= (a + c) + (b + d) \\
   y_1 &= (a - c) - i\,(b - d) \\
   y_2 &= (a + c) - (b + d) \\
   y_3 &= (a - c) + i\,(b - d)
   \end{aligned}
   ```

   The four partial sums $a \pm c$ and $b \pm d$ are each used twice, so 8 complex additions suffice instead
   of 12. Multiplying by $i$ costs no flops: $i\,(x + iy) = -y + ix$ is only a swap and a sign (`butterfly` in
   `kernel.rs`).

2. **Twiddle:** $`y_r`$ is multiplied by $`w_r[p] = W_L^{pr}`$. For $r = 0$ it is 1, so 3 multiplies remain. These
   are the tables of step 5.
3. **Recursion:** what is left, $`\sum_p (\dots)\, W_{L/4}^{pk'}`$, is one DFT of length $L/4$ for each $r$.

**Gain.** Per 4 points: 3 complex multiplies and 8 complex additions, 34 flops. Two radix-2 stages need 4
butterflies for the same 4 points, 40 flops. The leading term drops from $`5N\log_2 N`$ to $`4.25\,N\log_2 N`$,
and the number of stages from $`\log_2 N`$ to $`\log_4 N = \frac{1}{2}\log_2 N`$. If $`\log_2 N`$ is odd, one
radix-2 stage remains.

Going further pays less. The 8-point DFT of radix-8 contains $`W_8 = (1 - i)/\sqrt{2}`$, which needs real
multiplies. Split-radix mixes radix-2 and radix-4 and needs $`4N\log_2 N - 6N + 8`$ flops; the best known count
is about $`3.78\,N\log_2 N`$ (Johnson & Frigo 2007). Its structure is irregular, which makes vectorising harder,
so the kernel stays with plain radix-4.

### A.4 Stockham autosort

**Why.** In place, an FFT needs a permutation pass (bit reversal, A.2). That pass jumps through memory and does
not vectorise well. Stockham avoids it.

**How it works.** Stockham works out of place: each stage reads one buffer and writes the other. During a stage
of length $L$ there are $s = M/L$ independent sub-transforms (`stride` in the code). The layout rule is: element
$j$ of sub-transform $q$ sits at index $q + s\,j$. A radix-4 DIF stage (A.3) turns sub-transform $q$ into four
sub-transforms of length $L/4$, one per class $r$. Stockham numbers them $q' = q + s\,r$ and stores them with the
new stride $4s$:

```
read   a, b, c, d = x[q + stride·p + {0, 1, 2, 3}·quarter]      quarter = M/4 = stride·L/4
write  y[q + stride·(4p + r)]  =  y[q' + 4·stride·p]             r = 0..3
```

So after the stage the layout rule holds again, with $q'$ and $4s$. Each stage adds one base-4 digit $r$ to the
sub-transform number: in the first stage $s = 1$, so $r$ becomes the lowest digit; in the second $s = 4$, so the
next digit; and so on. By A.3, $r$ is exactly the next base-4 digit of the output bin ($k = 4k' + r$). After the
last stage every sub-transform has length 1, and its number $q'$ is its bin $k$: the output is in natural order.

**Gain.** No permutation pass. Every stage reads and writes contiguous blocks. The butterflies with the same $p$
and neighbouring $q$ share their twiddles and sit next to each other in memory, so the SIMD lanes can run over
$q$. Only the first stage ($s = 1$, a single $q$) needs another way (step 7). The price is a second buffer of the
same size.

### A.5 Real input: packing and twist

**Why.** An $N$-point complex FFT on real input wastes half its work. All imaginary inputs are zero, and half the
output is redundant: for real $x$, $X[N-k] = \overline{X[k]}$ ($\overline{\cdot}$ is the complex conjugate).

**How it works.** Pack two real samples into one complex value, $z[j] = x[2j] + i\,x[2j+1]$, $j = 0, \dots, M-1$,
$M = N/2$, and let $Z$ be the $M$-point DFT of $z$. The DFT is linear, so $Z = E + i\,O$, with $E$ and $O$ the DFTs
of the even and odd samples, as in A.1. Both are DFTs of real sequences, so $`E[M-k] = \overline{E[k]}`$ and
likewise for $O$. Hence

```math
\overline{Z[M-k]} = \overline{E[M-k]} + \overline{i\,O[M-k]} = E[k] - i\,O[k]
```

Adding and subtracting separates $E$ and $O$ again:

```math
A = Z[k] + \overline{Z[M-k]} = 2\,E[k], \qquad D = Z[k] - \overline{Z[M-k]} = 2i\,O[k]
```

The **twist** then combines them as in A.1:

```math
X[k] = E[k] + W^k\, O[k] = \tfrac{1}{2} A + U[k]\, D, \qquad U[k] = \frac{W^k}{2i} = -\tfrac{i}{2}\, W^k
```

The edge bins are $X[0] = \mathrm{Re}\,Z[0] + \mathrm{Im}\,Z[0]$ and $X[M] = \mathrm{Re}\,Z[0] - \mathrm{Im}\,Z[0]$.
The bins above $M$ follow from $X[N-k] = \overline{X[k]}$ and are not computed, so the output has $M + 1$ bins.

**Gain.** One $M$-point FFT plus a $\Theta(N)$ twist: about half the flops of an $N$-point complex FFT.

### A.6 Counting cost

- A complex addition is 2 flops. A complex multiply $(a + ib)(c + id) = (ac - bd) + i\,(ad + bc)$ is 4
  multiplications and 2 additions, 6 flops.
- A radix-2 FFT has $`\frac{N}{2}\log_2 N`$ butterflies × 10 flops $`= 5N\log_2 N`$. Benchmarks use this as the
  standard normalisation (FFTW reports "mflops" as $`5N\log_2 N`$ divided by the time; Frigo & Johnson 2005).
- Flops leave out memory. Each pass reads and writes the whole array, and scattered access (bit reversal, strided
  twiddles) costs more than contiguous access. That is why Part 1 also counts passes.

## Appendix B: SIMD128

### B.1 Vectors and lanes

**Why.** Scalar code handles one float per arithmetic instruction. An FFT applies the same operation to many
independent values (all butterflies of a stage), so scalar code leaves most of the CPU's vector width unused.

**How it works.** WebAssembly SIMD adds one 128-bit type, `v128`. Read as `f32x4`, it holds four f32 **lanes**.
One instruction works on all four: lane $j$ of the result comes from lane $j$ of the inputs. The wasm engine
compiles these instructions to the host's vector instructions (NEON on ARM, SSE/AVX on x86). In Rust they are in
`core::arch::wasm32` and need `-C target-feature=+simd128`, which the engine build sets. The kernel calls them
explicitly instead of hoping the compiler vectorises scalar code: the scalar radix-2 barely does, because of its
strided twiddles and data-dependent swaps.

**Gain.** Up to 4× fewer arithmetic instructions in the vectorised parts, and 4× fewer loads and stores where the
data is contiguous.

### B.2 Operations the kernel uses

**Why.** The kernel needs only a handful of operations. Knowing them is enough to read `v4.rs` and `kernel.rs`.

**How it works.**

| Operation                     | What it does                                                | In the kernel                 |
| ----------------------------- | ----------------------------------------------------------- | ----------------------------- |
| `v128.load` / `v128.store`    | 16 bytes from or to memory, no alignment requirement        | every data access             |
| `f32x4.splat`                 | copies one f32 into all four lanes                          | twiddle broadcast             |
| `f32x4.add` / `.sub` / `.mul` | lane by lane                                                | butterflies, complex multiply |
| `i8x16.shuffle`               | picks lanes from two vectors, indices fixed at compile time | transpose, packing, reversing |

Rust's `i32x4_shuffle::<A, B, C, D>` compiles to `i8x16.shuffle`: indices 0–3 pick from the first vector, 4–7
from the second. For example, `<0,4,1,5>` interleaves the low halves of two vectors, and `<0,2,4,6>` takes the even
lanes. Common patterns like these usually become one native instruction; others can cost more.

**Gain.** The small set keeps the abstraction `V4` small. That is what lets the native `[f32; 4]` fallback offer
the same API (B.5).

### B.3 Lane-wise against across lanes

**Why.** Vectors only help when the four lanes do the same thing on independent data. Whether a butterfly fits
that depends on where its inputs and outputs sit in memory.

**How it works.** Lane-wise operations (lane $j$ with lane $j$) are cheap. Moving data between lanes takes
shuffles: extra instructions that do no arithmetic. So the kernel arranges the data so that the four lanes hold
four independent, identical computations:

- **Stride ≥ 4** (all stages but the first): the butterflies $q, \dots, q + 3$ sit next to each other in memory
  and share one twiddle. Load, compute and store run lane by lane; the twiddle comes in with `splat`.
- **Stride 1** (first stage): neighbouring butterflies differ in $p$, and their outputs interleave at $4p + r$.
  The kernel computes four $p$ lane by lane and then reorders the results with a 4×4 transpose (step 7).

**Gain.** Shuffles appear only in the first stage, the twist and the conversion of input and output. All middle
stages run without a single shuffle.

### B.4 Interleaved against split

**Why.** Complex numbers can be stored in two ways. The choice decides whether a complex multiply needs shuffles.

**How it works.**

- **Interleaved** (array of structures): one vector holds `re0 im0 re1 im1`. The product
  $(a + ib)(c + id) = (ac - bd) + i\,(ad + bc)$ needs the real part of one factor times the imaginary part of the
  other. In this layout they sit in different lanes, so they must be duplicated and swapped with shuffles first.
- **Split** (structure of arrays): one vector holds four real parts $a$, another the four imaginary parts $b$;
  likewise $c$ and $d$. Then

  ```math
  \mathrm{re} = a\,c - b\,d, \qquad \mathrm{im} = a\,d + b\,c
  ```

  is 4 `mul` and 2 `add`/`sub`, all lane by lane, for four complex numbers at once (`C4::mul`).

**Gain.** A complex multiply without shuffles. The price is a conversion where the outside world is interleaved:
the real input (step 8) and the inverse's output (`Unpacked`).

### B.5 No FMA

**Why.** The native build should compute exactly the same bits as the wasm build. Then the native tests
(`cargo test`) check the same arithmetic the wasm kernel runs, and the native build can serve as a bit-exact
oracle for it. `node bits.mjs` checks this: it runs `simd` (forward and inverse) and `simd-complex` in both builds
for every size and signal and compares every output value bit for bit.

**How it works.** A fused multiply-add (FMA) computes $a b + c$ with one rounding instead of two, so its result can
differ in the last bit. Standard SIMD128 has no FMA: every `mul` and every `add` rounds to f32 on its own, exactly
like scalar f32 code on any machine, and Rust does not fuse $a b + c$ on its own either. The native fallback in
`v4.rs` does the same IEEE operations in the same order. Relaxed SIMD would offer `f32x4.relaxed_madd`, but its
result may be fused or not depending on the hardware.

**Gain.** Reproducible results on every machine, and native tests that run the same arithmetic as wasm. The cost: an FMA could replace two
of the six instructions of a complex multiply.

### B.6 Amdahl's law

**Why.** Vectorising part of the work does not speed up the rest. To predict a SIMD gain, you need the share that
stays scalar.

**How it works.** Normalise the run time to 1. A share $s$ stays scalar; the other $1 - s$ gets $v$ times faster.
The new run time is $s + (1 - s)/v$, so the total gain is

```math
S = \frac{1}{s + (1 - s)/v}
```

Even with $v \to \infty$, $S$ stays below $1/s$.

**Gain.** It shows where to work next. In step 6, $s = 8960 / 21528 = 0.42$ and $v = 4$ give only $S = 1.78$, with
a limit of $1/s = 2.4$. That is why steps 7 and 9 vectorise the scalar rest (first stage and twist): they shrink
$s$.

### B.7 Bounds checks

**Why.** Rust guarantees memory safety by checking every slice index at run time. In a tight loop these checks
cost about as many instructions as the arithmetic.

**How it works.** `slice[i]` compiles to a compare of $i$ with the length, a branch to a panic, and then the load.
The compiler can drop the check when it can prove the index is in range, as with iterators. For the computed
indices of an FFT (`q + stride·p + …`) it often cannot. The kernel therefore loads and stores its data through raw
pointers (`V4::load` / `V4::store`, `unsafe`). It checks the buffer lengths once per call, and `debug_assert!`
checks every access in the test build. A few scalar reads (twiddles before `splat`, DC and Nyquist) keep their
check. The wasm engine guards linear memory separately, on 64-bit hosts usually through guard
pages at no cost per access. Step 10 removes only the Rust checks.

**Gain.** A scalar radix-2 butterfly makes 10 accesses, so it carries 10 compares and branches next to its 10
flops. In the vectorised kernel, about 3 400 of the 3 600 accesses per call each lose a compare and a branch.

## References

- Amdahl, G. M. (1967). Validity of the single processor approach to achieving large scale computing
  capabilities. _AFIPS Spring Joint Computer Conference_, 30, 483–485.
- Cochran, W. T., et al. (1967). What is the fast Fourier transform? _Proceedings of the IEEE_, 55(10), 1664–1674.
- Cooley, J. W., & Tukey, J. W. (1965). An algorithm for the machine calculation of complex Fourier series.
  _Mathematics of Computation_, 19(90), 297–301.
- Duhamel, P., & Vetterli, M. (1990). Fast Fourier transforms: a tutorial review and a state of the art.
  _Signal Processing_, 19(4), 259–299.
- Frigo, M., & Johnson, S. G. (2005). The design and implementation of FFTW3. _Proceedings of the IEEE_, 93(2),
  216–231.
- Johnson, S. G., & Frigo, M. (2007). A modified split-radix FFT with fewer arithmetic operations. _IEEE
  Transactions on Signal Processing_, 55(1), 111–119.
- Sorensen, H. V., Jones, D. L., Heideman, M. T., & Burrus, C. S. (1987). Real-valued fast Fourier transform
  algorithms. _IEEE Transactions on Acoustics, Speech, and Signal Processing_, 35(6), 849–863.
- Stockham, T. G., Jr. (1966). High-speed convolution and correlation. _AFIPS Spring Joint Computer Conference_,
  28, 229–233.
- Van Loan, C. (1992). _Computational Frameworks for the Fast Fourier Transform_. SIAM.
- WebAssembly Core Specification 2.0, vector instructions: https://www.w3.org/TR/wasm-core-2/
