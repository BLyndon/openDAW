//! Radix-4 Stockham FFT on split re/im arrays with `f32x4` butterflies, and a real-input FFT on top of it (an
//! N/2-point complex FFT of the samples taken in pairs, then a twist). Stockham sorts as it goes: no bit
//! reversal, natural-order output, contiguous twiddles. `no_std` + `alloc`.

use super::v4::V4;
use alloc::vec;
use alloc::vec::Vec;
use core::f64::consts::PI;

/// Four consecutive complex values, split.
#[derive(Clone, Copy)]
pub(crate) struct C4 {
    pub(crate) re: V4,
    pub(crate) im: V4
}

impl C4 {
    #[inline(always)]
    pub(crate) fn add(self, other: Self) -> Self {
        C4 { re: self.re.add(other.re), im: self.im.add(other.im) }
    }

    #[inline(always)]
    pub(crate) fn sub(self, other: Self) -> Self {
        C4 { re: self.re.sub(other.re), im: self.im.sub(other.im) }
    }

    /// (a + ib)(c + id) = (ac − bd) + i(ad + bc)
    #[inline(always)]
    pub(crate) fn mul(self, other: Self) -> Self {
        C4 { re: self.re.mul(other.re).sub(self.im.mul(other.im)), im: self.re.mul(other.im).add(self.im.mul(other.re)) }
    }

    #[inline(always)]
    pub(crate) fn scale(self, factor: V4) -> Self {
        C4 { re: self.re.mul(factor), im: self.im.mul(factor) }
    }

    #[inline(always)]
    pub(crate) fn reverse(self) -> Self {
        C4 { re: self.re.reverse(), im: self.im.reverse() }
    }
}

pub(crate) trait Source {
    /// # Safety
    /// Complex values `index..index + 4` exist.
    unsafe fn load(&self, index: usize) -> C4;
}

pub(crate) trait Sink {
    /// # Safety
    /// Complex values `index..index + 4` exist.
    unsafe fn store(&mut self, index: usize, value: C4);
}

pub(crate) struct Split<'a> {
    pub(crate) re: &'a [f32],
    pub(crate) im: &'a [f32]
}

impl Source for Split<'_> {
    #[inline(always)]
    unsafe fn load(&self, index: usize) -> C4 {
        C4 { re: V4::load(self.re, index), im: V4::load(self.im, index) }
    }
}

struct SplitMut<'a> {
    re: &'a mut [f32],
    im: &'a mut [f32]
}

impl Sink for SplitMut<'_> {
    #[inline(always)]
    unsafe fn store(&mut self, index: usize, value: C4) {
        value.re.store(self.re, index);
        value.im.store(self.im, index);
    }
}

/// Split output times a constant: the complex inverse's 1/n, folded into its last stage.
struct ScaledMut<'a> {
    re: &'a mut [f32],
    im: &'a mut [f32],
    scale: V4
}

impl Sink for ScaledMut<'_> {
    #[inline(always)]
    unsafe fn store(&mut self, index: usize, value: C4) {
        value.re.mul(self.scale).store(self.re, index);
        value.im.mul(self.scale).store(self.im, index);
    }
}

/// Real samples read as complex values z[j] = x[2j] + i·x[2j + 1].
pub(crate) struct Packed<'a>(pub(crate) &'a [f32]);

impl Source for Packed<'_> {
    #[inline(always)]
    unsafe fn load(&self, index: usize) -> C4 {
        let (low, high) = (V4::load(self.0, 2 * index), V4::load(self.0, 2 * index + 4));
        C4 { re: low.shuffle::<0, 2, 4, 6>(high), im: low.shuffle::<1, 3, 5, 7>(high) }
    }
}

/// The inverse's swapped view written back as real samples: x[2j] = im, x[2j + 1] = re.
pub(crate) struct Unpacked<'a>(pub(crate) &'a mut [f32]);

impl Sink for Unpacked<'_> {
    #[inline(always)]
    unsafe fn store(&mut self, index: usize, value: C4) {
        let (re, im) = (value.im, value.re);
        re.shuffle::<0, 4, 1, 5>(im).store(self.0, 2 * index);
        re.shuffle::<2, 6, 3, 7>(im).store(self.0, 2 * index + 4);
    }
}

/// The 4-point DFT of (a, b, c, d) with the forward sign, before twiddles.
#[inline(always)]
pub(crate) fn butterfly(a: C4, b: C4, c: C4, d: C4) -> [C4; 4] {
    let (apc, amc, bpd, bmd) = (a.add(c), a.sub(c), b.add(d), b.sub(d));
    // amc − i·bmd and amc + i·bmd, with i·(x + iy) = −y + ix
    let y1 = C4 { re: amc.re.add(bmd.im), im: amc.im.sub(bmd.re) };
    let y3 = C4 { re: amc.re.sub(bmd.im), im: amc.im.add(bmd.re) };
    [apc.add(bpd), y1, apc.sub(bpd), y3]
}

/// 4×4 transpose: lane j of row r becomes lane r of row j.
#[inline(always)]
pub(crate) fn transpose(rows: [V4; 4]) -> [V4; 4] {
    let [r0, r1, r2, r3] = rows;
    let (t0, t1) = (r0.shuffle::<0, 4, 1, 5>(r1), r0.shuffle::<2, 6, 3, 7>(r1));
    let (t2, t3) = (r2.shuffle::<0, 4, 1, 5>(r3), r2.shuffle::<2, 6, 3, 7>(r3));
    [t0.shuffle::<0, 1, 4, 5>(t2), t0.shuffle::<2, 3, 6, 7>(t2), t1.shuffle::<0, 1, 4, 5>(t3), t1.shuffle::<2, 3, 6, 7>(t3)]
}

/// Six blocks of `length / 4` values, [w1.re | w1.im | w2.re | w2.im | w3.re | w3.im], with
/// w_k[p] = exp(−2πi·k·p / length). Computed in f64, stored f32.
pub(crate) fn stage_twiddles(length: usize) -> Vec<f32> {
    let count = length / 4;
    let mut table = vec![0.0; 6 * count];
    for k in 1..4 {
        for p in 0..count {
            let angle = -2.0 * PI * (k * p) as f64 / length as f64;
            table[2 * (k - 1) * count + p] = libm::cos(angle) as f32;
            table[(2 * (k - 1) + 1) * count + p] = libm::sin(angle) as f32;
        }
    }
    table
}

enum Stage {
    /// Splits each sub-transform of length `size / stride` into four of a quarter the length.
    Radix4 { stride: usize, twiddles: Vec<f32> },
    /// The last stage when log2(size) is odd: length-2 DFTs, no twiddles.
    Radix2
}

impl Stage {
    /// # Safety
    /// `from` and `to` hold `size` complex values.
    #[inline(always)]
    unsafe fn run<S: Source, D: Sink>(&self, size: usize, from: &S, to: &mut D) {
        match self {
            Stage::Radix4 { stride: 1, twiddles } => radix4_first(size, twiddles, from, to),
            Stage::Radix4 { stride, twiddles } => radix4(size, *stride, twiddles, from, to),
            Stage::Radix2 => radix2(size, from, to)
        }
    }
}

/// Stride 1: lanes run over p, so the four outputs of each p are transposed into place.
#[inline(always)]
pub(crate) unsafe fn radix4_first<S: Source, D: Sink>(size: usize, twiddles: &[f32], from: &S, to: &mut D) {
    let quarter = size / 4;
    let twiddle = |k: usize, p: usize| C4 {
        re: V4::load(twiddles, 2 * k * quarter + p),
        im: V4::load(twiddles, (2 * k + 1) * quarter + p)
    };
    for p in (0..quarter).step_by(4) {
        let [y0, y1, y2, y3] =
            butterfly(from.load(p), from.load(p + quarter), from.load(p + 2 * quarter), from.load(p + 3 * quarter));
        let (y1, y2, y3) = (y1.mul(twiddle(0, p)), y2.mul(twiddle(1, p)), y3.mul(twiddle(2, p)));
        // Lane j of y_r is output 4(p + j) + r.
        let [re0, re1, re2, re3] = transpose([y0.re, y1.re, y2.re, y3.re]);
        let [im0, im1, im2, im3] = transpose([y0.im, y1.im, y2.im, y3.im]);
        to.store(4 * p, C4 { re: re0, im: im0 });
        to.store(4 * p + 4, C4 { re: re1, im: im1 });
        to.store(4 * p + 8, C4 { re: re2, im: im2 });
        to.store(4 * p + 12, C4 { re: re3, im: im3 });
    }
}

/// Stride ≥ 4: lanes run over q; one twiddle per p, broadcast. Inputs of a butterfly are `size / 4` apart.
#[inline(always)]
unsafe fn radix4<S: Source, D: Sink>(size: usize, stride: usize, twiddles: &[f32], from: &S, to: &mut D) {
    let quarter = size / 4;
    let count = quarter / stride;
    let twiddle = |k: usize, p: usize| C4 {
        re: V4::splat(twiddles[2 * k * count + p]),
        im: V4::splat(twiddles[(2 * k + 1) * count + p])
    };
    // p = 0 has all twiddles 1.
    for q in (0..stride).step_by(4) {
        let [y0, y1, y2, y3] =
            butterfly(from.load(q), from.load(q + quarter), from.load(q + 2 * quarter), from.load(q + 3 * quarter));
        to.store(q, y0);
        to.store(q + stride, y1);
        to.store(q + 2 * stride, y2);
        to.store(q + 3 * stride, y3);
    }
    for p in 1..count {
        let (w1, w2, w3) = (twiddle(0, p), twiddle(1, p), twiddle(2, p));
        let (read, write) = (stride * p, 4 * stride * p);
        for q in (0..stride).step_by(4) {
            let index = read + q;
            let [y0, y1, y2, y3] = butterfly(from.load(index), from.load(index + quarter), from.load(index + 2 * quarter),
                from.load(index + 3 * quarter));
            to.store(write + q, y0);
            to.store(write + q + stride, y1.mul(w1));
            to.store(write + q + 2 * stride, y2.mul(w2));
            to.store(write + q + 3 * stride, y3.mul(w3));
        }
    }
}

#[inline(always)]
pub(crate) unsafe fn radix2<S: Source, D: Sink>(size: usize, from: &S, to: &mut D) {
    let half = size / 2;
    for q in (0..half).step_by(4) {
        let (a, b) = (from.load(q), from.load(q + half));
        to.store(q, a.add(b));
        to.store(q + half, a.sub(b));
    }
}

struct Plan {
    size: usize,
    stages: Vec<Stage>
}

impl Plan {
    fn new(size: usize) -> Self {
        assert!(size.is_power_of_two() && size >= 16, "complex size must be a power of two >= 16");
        let (mut stages, mut length) = (Vec::new(), size);
        while length >= 4 {
            stages.push(Stage::Radix4 { stride: size / length, twiddles: stage_twiddles(length) });
            length /= 4;
        }
        if length == 2 {
            stages.push(Stage::Radix2);
        }
        Self { size, stages }
    }

    fn last(&self) -> usize {
        self.stages.len() - 1
    }
}

struct Work {
    re: Vec<f32>,
    im: Vec<f32>
}

impl Work {
    fn new(size: usize) -> Self {
        Self { re: vec![0.0; size], im: vec![0.0; size] }
    }
}

/// Stage `index` reads `work[(index + 1) % 2]` and writes `work[index % 2]`.
fn ping_pong(work: &mut [Work; 2], index: usize) -> (Split<'_>, SplitMut<'_>) {
    let [even, odd] = work;
    let (from, to) = if index % 2 == 0 { (&*odd, even) } else { (&*even, odd) };
    (Split { re: &from.re, im: &from.im }, SplitMut { re: &mut to.re, im: &mut to.im })
}

/// In-place complex FFT of one power-of-two size ≥ 16 on split arrays; `inverse` scales by 1/size. The
/// inverse runs the forward stages on (im, re): swapping re and im conjugates up to a factor i, and
/// IDFT(x) = swap(DFT(swap(x))).
pub struct Fft {
    plan: Plan,
    work: [Work; 2]
}

impl Fft {
    pub fn new(size: usize) -> Self {
        Self { plan: Plan::new(size), work: [Work::new(size), Work::new(size)] }
    }

    pub fn size(&self) -> usize {
        self.plan.size
    }

    pub fn stages(&self) -> usize {
        self.plan.stages.len()
    }

    pub fn forward(&mut self, re: &mut [f32], im: &mut [f32]) {
        for index in 0..self.stages() {
            self.stage(re, im, index, false);
        }
    }

    pub fn inverse(&mut self, re: &mut [f32], im: &mut [f32]) {
        for index in 0..self.stages() {
            self.stage(re, im, index, true);
        }
    }

    /// One stage; run them in order. The first reads `re`/`im`, the last writes them, the rest stay in
    /// the work buffers.
    pub fn stage(&mut self, re: &mut [f32], im: &mut [f32], index: usize, inverse: bool) {
        let size = self.plan.size;
        assert!(re.len() == size && im.len() == size, "buffer length must equal fft size");
        let stage = &self.plan.stages[index];
        // SAFETY: every buffer holds `size` values (asserted above, `Work::new(size)`).
        unsafe {
            if index == 0 {
                let from = if inverse { Split { re: im, im: re } } else { Split { re, im } };
                stage.run(size, &from, &mut ping_pong(&mut self.work, 0).1);
            } else if index == self.plan.last() {
                let from = ping_pong(&mut self.work, index).0;
                if inverse {
                    stage.run(size, &from, &mut ScaledMut { re: im, im: re, scale: V4::splat(1.0 / size as f32) });
                } else {
                    stage.run(size, &from, &mut SplitMut { re, im });
                }
            } else {
                let (from, mut to) = ping_pong(&mut self.work, index);
                stage.run(size, &from, &mut to);
            }
        }
    }
}

/// U[k] for k in 0..=M/2 (index 0 unused) and the factor on the sum term; see `twist`.
struct Twist {
    re: Vec<f32>,
    im: Vec<f32>,
    half: f32
}

impl Twist {
    /// Forward: U[k] = −i·W^k / 2 with W = exp(−2πi/N), half = 1/2. Inverse: conj(U[k]) and half, both / M.
    fn new(size: usize, inverse: bool) -> Self {
        let m = size / 2;
        let scale = if inverse { 1.0 / m as f64 } else { 1.0 };
        let (mut re, mut im) = (vec![0.0; m / 2 + 1], vec![0.0; m / 2 + 1]);
        for k in 0..=m / 2 {
            let angle = 2.0 * PI * k as f64 / size as f64;
            // −i·(cos − i·sin) / 2 = (−sin − i·cos) / 2
            re[k] = (-0.5 * libm::sin(angle) * scale) as f32;
            im[k] = (if inverse { 0.5 } else { -0.5 } * libm::cos(angle) * scale) as f32;
        }
        Self { re, im, half: (0.5 * scale) as f32 }
    }
}

/// For k in 1..=M/2: to[k] = half·A + U[k]·D and to[M − k] = conj(half·A − U[k]·D), with
/// A = from[k] + conj(from[M − k]) and D = from[k] − conj(from[M − k]). Index 0 is the caller's.
///
/// # Safety
/// `from` and `to` hold at least M values, `table` M/2 + 1.
#[inline(always)]
unsafe fn twist(m: usize, table: &Twist, from: &Split, to: &mut SplitMut) {
    let half = V4::splat(table.half);
    for k in (1..=m / 2).step_by(4) {
        // Lanes k..k+3 pair with M−k..M−k−3: that block is loaded forwards from M−k−3 and reversed.
        let mirror = m - k - 3;
        let (value, other) = (from.load(k), from.load(mirror).reverse());
        let sum = C4 { re: value.re.add(other.re), im: value.im.sub(other.im) };
        let difference = C4 { re: value.re.sub(other.re), im: value.im.add(other.im) };
        let even = sum.scale(half);
        let odd = difference.mul(C4 { re: V4::load(&table.re, k), im: V4::load(&table.im, k) });
        to.store(k, even.add(odd));
        to.store(mirror, C4 { re: even.re.sub(odd.re), im: odd.im.sub(even.im) }.reverse());
    }
}

/// Real-input FFT of one power-of-two size N ≥ 32. `forward` writes N/2 + 1 unnormalised bins (split);
/// `inverse` undoes it exactly, 1/N included.
pub struct RealFft {
    size: usize,
    plan: Plan,
    forward_twist: Twist,
    inverse_twist: Twist,
    work: [Work; 2]
}

impl RealFft {
    pub fn new(size: usize) -> Self {
        assert!(size.is_power_of_two() && size >= 32, "size must be a power of two >= 32");
        let m = size / 2;
        Self { size, plan: Plan::new(m), forward_twist: Twist::new(size, false), inverse_twist: Twist::new(size, true),
            work: [Work::new(m), Work::new(m)] }
    }

    pub fn size(&self) -> usize {
        self.size
    }

    pub fn forward(&mut self, input: &[f32], re: &mut [f32], im: &mut [f32]) {
        let (m, last) = (self.size / 2, self.plan.last());
        assert!(input.len() == self.size && re.len() > m && im.len() > m, "buffer lengths do not match the size");
        // SAFETY: `input` holds 2M samples, `re`/`im` M + 1 bins (asserted), the work buffers M values.
        unsafe {
            self.plan.stages[0].run(m, &Packed(input), &mut ping_pong(&mut self.work, 0).1);
            for index in 1..=last {
                let (from, mut to) = ping_pong(&mut self.work, index);
                self.plan.stages[index].run(m, &from, &mut to);
            }
            let result = &self.work[last % 2];
            twist(m, &self.forward_twist, &Split { re: &result.re, im: &result.im }, &mut SplitMut { re: &mut *re, im: &mut *im });
            // Z[0] = Σ even + i·Σ odd, so X[0] = Re Z[0] + Im Z[0] and X[M] = Re Z[0] − Im Z[0].
            let (sum_even, sum_odd) = (result.re[0], result.im[0]);
            (re[0], im[0], re[m], im[m]) = (sum_even + sum_odd, 0.0, sum_even - sum_odd, 0.0);
        }
    }

    pub fn inverse(&mut self, re: &[f32], im: &[f32], output: &mut [f32]) {
        let (m, last) = (self.size / 2, self.plan.last());
        assert!(output.len() == self.size && re.len() > m && im.len() > m, "buffer lengths do not match the size");
        // SAFETY: as in `forward`.
        unsafe {
            let [even, odd] = &mut self.work;
            // Stage 0 reads work[1].
            twist(m, &self.inverse_twist, &Split { re, im }, &mut SplitMut { re: &mut odd.re, im: &mut odd.im });
            let half = self.inverse_twist.half;
            (odd.re[0], odd.im[0]) = (half * (re[0] + re[m]), half * (re[0] - re[m]));
            self.plan.stages[0].run(m, &Split { re: &odd.im, im: &odd.re }, &mut SplitMut { re: &mut even.re, im: &mut even.im });
            for index in 1..last {
                let (from, mut to) = ping_pong(&mut self.work, index);
                self.plan.stages[index].run(m, &from, &mut to);
            }
            self.plan.stages[last].run(m, &ping_pong(&mut self.work, last).0, &mut Unpacked(output));
        }
    }
}
