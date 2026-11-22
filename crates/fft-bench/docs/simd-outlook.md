# SIMD kernel: outlook

What else the prototype kernel (`src/options/simd/`) could gain on standard SIMD128, after the ten steps of
[simd-kernel.md](simd-kernel.md). Nothing here is implemented or measured. Counts are by hand from `kernel.rs`, for
the forward transform at **$N = 1024$** ($M = 512$) unless stated otherwise; **expected factors are estimates**.
Constraints as in the plan: f32, standard SIMD128 only (no relaxed SIMD), no allocation after plan creation, native
and wasm bit-identical.

## Where the time goes today

| Part                          | Instructions (arith. + shuffles) | Vector loads + stores | Passes |
| ----------------------------- | -------------------------------- | --------------------- | ------ |
| First stage (incl. `Packed`)  | 1 856                            | 512 + 192 twiddles    | 1      |
| Stages 2–4 (radix-4)          | 2 886                            | 1 536                 | 3      |
| Radix-2 stage                 | 256                              | 512                   | 1      |
| Twist                         | 1 280                            | 640                   | 1      |
| Scalar twiddle reads + splats | 234 + 234                        | –                     | –      |
| **Total**                     | **6 278 + 468 scalar**           | **≈ 3 400**           | **6**  |

Two observations drive the outlook:

- **Memory traffic** is the larger cost: the measured gain over `rfft` (7.6–8.2×) tracks the memory-access ratio
  (about 8×) more closely than the instruction ratio (4.8×) (simd-kernel.md, "Expected against measured"). The
  items that remove whole passes (O1–O3) are therefore ranked first.
- **Shuffles** are 1 024 of the 6 278 counted instructions (16 %). How cheaply they run depends on the engine's
  lowering ([O9](#o9-check-the-shuffle-lowering-per-engine)).

## Overview

| Item | Optimisation                                           | Saves at $N = 1024$                    | Expected       | Effort |
| ---- | ------------------------------------------------------ | -------------------------------------- | -------------- | ------ |
| O1   | Fuse the last stage with the twist (forward)           | 1 pass, 512 accesses                   | 1.05–1.1×      | medium |
| O2   | Radix-8 last stage when $`\log_2 M`$ is odd            | 1 pass, 512 accesses, 160 instructions | 1.05–1.1×      | medium |
| O3   | Fuse the pre-twist with the first stage (inverse)      | 1 pass, 512 accesses                   | 1.05–1.1× inv. | high   |
| O4   | `v128.load32_splat` for the broadcast twiddles         | 234 bounds checks, 234 splats          | 1.03–1.05×     | low    |
| O5   | Caller buffers as a ping-pong buffer (forward)         | 2M floats of working set               | x86, large N   | low    |
| O6   | Batch of four transforms, lanes over signals           | all 1 024 shuffles, per-call overhead  | 1.2–1.4×       | high   |
| O7   | Fuse window, overlap-add and magnitude into the kernel | 1 pass per fused step (consumer side)  | consumer       | low    |
| O8   | Small sizes: per-call overhead                         | to be measured first                   | open           | low    |
| O9   | Check the shuffle lowering per engine                  | (diagnosis)                            | –              | low    |
| O10  | Alignment of work buffers and tables                   | cache-line-split loads                 | ≤ 1.02×        | low    |

O1, O2 and O4 together: 6 → 4 passes, about 3 400 → 2 400 vector accesses (−30 %), about 160 instructions and
470 scalar operations fewer. Estimated **1.15–1.3×** on the forward at $N = 1024$, more where the kernel is
memory-bound.

## O1: fuse the last stage with the twist (forward)

**What.** Today the last stage writes $Z$ into a work buffer and the twist reads it back. The twist pairs $Z[k]$
with $Z[M-k]$. Both come from the last stage, in a fixed pattern:

- **Radix-2 last stage** (stride $M/2$): butterfly $q$ writes $Z[q]$ and $Z[q + M/2]$. The partner of $q$ is
  $M - q = (M/2 - q) + M/2$, the second output of butterfly $M/2 - q$.
- **Radix-4 last stage** (length 4, $p = 0$ only, stride $M/4$): butterfly $q$ writes $Z[q + r M/4]$. The partner is
  $(M/4 - q) + (3 - r) M/4$, an output of butterfly $M/4 - q$.

So a loop that runs butterfly block $q$ and its mirror block together has both halves of every twist pair in
registers. It computes the twist right away and stores $X$ only. The mirror block is loaded forwards and reversed,
as the twist does today.

**Saves.** One pass: the 256 vector stores of the last stage and the 256 vector loads of the twist. Instructions
unchanged. This is the "fusing" item of simd-kernel.md, Open points; the structure above shows it works for both
last-stage shapes.

**Care.** Bit-identical to today if the operations stay in the same order. The middle bin $k = M/2$ and the edge
bins need their own path, as today.

## O2: radix-8 last stage when $`\log_2 M`$ is odd

**What.** For odd $`\log_2 M`$ the stages end with a radix-4 stage of length 8 (twiddle groups $p = 0, 1$) and a
radix-2 stage. Merged, they are one 8-point DFT per sub-transform: length 8, stride $M/8$, only $p = 0$, so no
table twiddles. Inside it, $W_8 = (1 - i)/\sqrt{2}$ costs 2 muls + 2 adds per product, twice per butterfly.

**This hits the headline sizes.** $N = 256$, 1024 and 4096 ($M = 2^7, 2^9, 2^{11}$) all have the radix-2 stage
today; $N = 2048$ and 8192 do not.

**Saves.** One pass (512 accesses). Flops for these two stages: 64 × 16 + 64 × 34 + 256 × 4 = 4 224 → 64 × 56 =
3 584, about 160 instructions fewer.

**Care.** 8 complex inputs are 16 `v128` values plus temporaries. x86-64 has 16 XMM registers, and the engines keep
one or two for themselves, so some spilling is likely there; NEON has 32. Measure on both. O1 composes with O2: the
partner of $q + rM/8$ is an output of butterfly $M/8 - q$.

## O3: fuse the pre-twist with the first stage (inverse)

**What.** The inverse runs the pre-twist as its own pass (`RealFft::inverse`), then the first stage. The first stage
reads $p, p + M/4, p + M/2, p + 3M/4$. The pre-twist output at $p$ needs input $M - p = (M/4 - p) + 3M/4$, which the
first-stage butterfly $M/4 - p$ reads. Running block $p$ together with block $M/4 - p - 3$ again has all twist
pairs in registers.

**Saves.** One pass on the inverse (512 accesses). It also removes one of the suspects for the slower inverse at
$N = 4096$ (simd-kernel.md, Open points).

**Care.** The most involved item: the first stage runs its lanes over $p$ and transposes its outputs (step 7), and
the swap trick ($\mathrm{re} \leftrightarrow \mathrm{im}$) has to be threaded through. Worth it only if the inverse
matters for the time-stretch budget.

## O4: `v128.load32_splat` for the broadcast twiddles

**What.** In the stages with stride ≥ 4 each twiddle is read as a scalar with a bounds check, then broadcast
(`V4::splat(twiddles[...])`): `f32.load` + compare + branch + `f32x4.splat`. SIMD128 has one instruction for this,
`v128.load32_splat` (`core::arch::wasm32::v128_load32_splat`). It maps to `vbroadcastss` / `ld1r` on the host. A
`V4::load_splat(slice, index)` next to `V4::load`, with the same `debug_assert!`, would cover it; the native
fallback reads one f32 and splats.

**Where it matters.** The stride-4 stage (second stage) runs its inner `q` loop exactly once per $p$, so per vector
butterfly it reads 6 twiddles with 6 checks and 6 splats. At $N = 1024$ that is 31 of the 32 groups of that
stage, 186 of the 234 reads. A dedicated stride-4 path without the inner loop would also drop its loop overhead.

**Saves.** 234 bounds checks and the separate splats, about 3 machine instructions per read. The alternative,
pre-splatted tables (4× the memory for that stage), saves the same with more cache.

## O5: caller buffers as a ping-pong buffer (forward)

**What.** The forward uses two work buffers of $M$ complex values, then the twist writes into the caller's `re`/`im`
(length $M + 1$). The twist can run in place: each iteration reads blocks $k$ and $M - k - 3$ before it writes
them, and no other iteration touches them. So the caller's `re`/`im` can serve as one of the two ping-pong buffers,
with the stage parity choosing the order.

**Saves.** $2M$ floats of working set (16 KB at $N = 4096$, 64 KB at $N = 16384$).

**When.** Only where L1 is the limit. On the measuring machine (Apple M1, 128 KB L1D per performance core), the
working set at $N = 4096$ is about 90 KB and fits. Chrome shows no drop in the gain from $N = 1024$ to 4096 (8.2× at
both, `analysis/README.md`). On x86 with 32–48 KB L1D, or at $N \ge 8192$, it may matter. Measure there first.

## O6: batch of four transforms, lanes over signals

**What.** A second kernel shape: lane $j$ holds transform $j$ of four independent ones of the same size. Then every
stage is lane-parallel by construction, including the first stage (no transpose) and the twist (no reversal), and
every twiddle is a broadcast. The code is the scalar radix-4 Stockham with `V4` in place of `f32`.

**Fits.** The time-stretch runs one FFT per voice per block (`future-plans/simd-fft.md`), so with $V \ge 4$ voices
four transforms of the same size are due at the same time. Stereo analysis with two channels is half a batch.

**Saves.** All 1 024 shuffles per transform at $N = 1024$ (16 % of the instructions), and the per-call overhead
(dispatch, assertions, loop set-up) is paid once for four transforms, which matters most at $N = 256$.

**Costs.** The data must be interleaved by signal (`x0[n] x1[n] x2[n] x3[n]`). If the caller does not keep it that
way, a 4×4 transpose on input and output (Θ(N), 1 shuffle per value) eats part of the gain. Four times the work
buffer, and a second kernel to maintain. This is a design question for the maintainer, not a drop-in step.

## O7: fuse window, overlap-add and magnitude into the kernel

**What.** The `Source` / `Sink` traits are monomorphised and inlined, so extra work at the edges is free of calls:

- **Analysis window** (Hann, phase vocoder): a `WindowedPacked` source multiplies the 8 samples it loads by the
  window, 2 `mul` per `C4`, and saves the separate windowing pass.
- **Synthesis window + overlap-add** (inverse): an `Unpacked` variant that computes `output += window · x` saves
  two passes.
- **Magnitudes** (analyser): the twist could write $|X|^2$ (or $|X|$) through a `Sink` instead of `re`/`im`, which
  saves the magnitude pass. Today `twist` writes `SplitMut` directly; it would take a `Sink` instead.

**Saves.** Passes in the consumers, not in the FFT itself. The requirements list windowed helpers anyway
(`future-plans/simd-fft.md`), so this is where they could live.

## O8: small sizes, per-call overhead

**What.** At $N = 256$ ($M = 128$) the stages are short: the stride-16 stage has 2 groups of 4 vector butterflies.
Fixed costs per call (length assertions, the `match` in `Stage::run`, indexing `stages`, loop set-up per stage and
group) weigh more there. Options: a dedicated path for the smallest sizes, or O6.

**First.** The harness reports single-call time at $N = 256$ separately; take that number before changing anything.
Size-specialised code costs Wasm binary size, which the decision page tracks.

## O9: check the shuffle lowering per engine

**What.** `i8x16.shuffle` with constant indices is pattern-matched by each engine. The kernel's patterns and their
usual native form:

| Pattern (i32 lanes)     | Use                   | x86 (SSE)               | ARM64 (NEON)          |
| ----------------------- | --------------------- | ----------------------- | --------------------- |
| `<0,2,4,6>` `<1,3,5,7>` | `Packed`              | `shufps`                | `uzp1` / `uzp2`       |
| `<0,4,1,5>` `<2,6,3,7>` | transpose, `Unpacked` | `unpcklps` / `unpckhps` | `zip1` / `zip2`       |
| `<0,1,4,5>` `<2,3,6,7>` | transpose             | `movlhps` / `unpckhpd`  | `zip1.2d` / `zip2.2d` |
| `<3,2,1,0>`             | twist reversal        | `pshufd`                | `rev64` + `ext` (2)   |

If an engine misses a pattern, it falls back to a generic byte shuffle (`pshufb` / `tbl` with a constant), several
times as expensive. That could make the browsers differ more than the arithmetic does.

**How.** Dump the generated code (`node --print-wasm-code`, or d8) for V8; SpiderMonkey and JavaScriptCore need
their own flags. Compare with the per-browser numbers once Firefox and Safari are in.

## O10: alignment of work buffers and tables

**What.** `Vec<f32>` is only guaranteed 4-byte alignment. All stage accesses are at multiples of 4 floats, so with
16-byte-aligned buffers no load would cross a cache line. Work buffers and tables could be allocated as 16-byte-aligned
blocks (for example a `#[repr(align(16))]` element type). The caller's buffers stay as they are.

**The twist cannot be fully aligned.** Block $k \dots k+3$ pairs with $M-k-3 \dots M-k$; both start at a multiple of
4 only if $3 \equiv 0 \pmod 4$. Today the $k$ side is offset by one float, so about one in four of its loads and
stores crosses a 64-byte line. Moving the offset to the other side changes nothing.

**Expected.** Small on current x86 and ARM cores; listed for completeness. Measure before doing it.

## Not recommended

- **Relaxed SIMD FMA** (`f32x4.relaxed_madd`): would save 2 of 6 instructions per complex multiply, but excluded by
  the plan, and its result may be fused or not depending on the hardware, which breaks the bit-exact native oracle
  (simd-kernel.md, B.5).
- **Split-radix:** a few percent fewer flops, irregular structure, hard to vectorise (simd-kernel.md, A.3).
- **Radix-16 stages in registers:** 32 `v128` values per butterfly, which spill on x86-64.
- **Twiddles from symmetry or recurrence** (one quarter-wave table, or $w_2 = w_1^2$, $w_3 = w_1 w_2$ on the fly):
  less table memory, but either shuffles in the first stage or extra multiplies and rounding error. The tables are
  already loaded only $\Theta(N)$ times.

## Suggested order

1. **Measure where the time goes**: per-stage timing through the existing `steps` / `step` API of the complex
   variant (`simd-complex`, `src/wasm.rs`), and the single-call time at $N = 256$. This replaces the table at the top
   with numbers.
2. **O4**, small and local.
3. **O1 + O2** together, since O2 changes the last stage O1 fuses into.
4. **O9** once Firefox and Safari numbers are in, to explain browser differences.
5. **O3, O5, O6, O7** depending on what the time-stretch and the analyser actually need; O6 is a question for the
   maintainer.

## Prototypes

O1–O5, O10 and O6 exist as cumulative prototypes, one stage per item and each with every item before it: S0
(`simd`), O1, O2, O3, O4, O5, O10, O6.

- **Code:** `src/options/outlook/kernel.rs` (`RealFft<LEVEL>`, one level per item), `src/options/outlook/batch.rs`
  (O6), registry `outlook::STAGES`.
- **Tests:** `tests/stages.rs`: gates for every stage, no allocation after `new`, and the bits of the stage before
  wherever the item leaves the arithmetic unchanged (all but O2 at odd $`\log_2 M`$; every O6 lane gives the bits
  of O10). `node bits.mjs` also checks the wasm build of every stage against the native bits.
- **Measured:** `node web/serve.mjs`, then `/stages`: time per transform by stage, one line per $N$ from 1024 to
  16384, and the speed-up against S0.
