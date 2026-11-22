//! The outlook items of `docs/simd-outlook.md` on top of the `simd` kernel, one bit per item. `RealFft<FEATURES>` has
//! the items whose bits are set; O1 is always required. Prototype for measuring, not for the engine.

use crate::options::simd::kernel::{butterfly, radix2, radix4_first, stage_twiddles, transpose, Packed, Sink, Source, Split, Unpacked, C4};
use crate::options::simd::v4::V4;
use alloc::vec;
use alloc::vec::Vec;
use core::f64::consts::{FRAC_1_SQRT_2, PI};

/// O1: the forward's last stage and twist in one pass.
pub const FUSED_TWIST: usize = 1 << 0;
/// O2: one radix-8 last stage instead of radix-4 (length 8) + radix-2 when log2(M) is odd.
pub const RADIX8: usize = 1 << 1;
/// O3: the inverse's pre-twist and first stage in one pass.
pub const FUSED_PRE_TWIST: usize = 1 << 2;
/// O4: broadcast twiddles with one `v128.load32_splat`.
pub const LOAD_SPLAT: usize = 1 << 3;
/// O5: the caller's buffers serve as one of the two ping-pong buffers.
pub const CALLER_BUFFERS: usize = 1 << 4;
/// O10: work buffers and tables start on a 16-byte boundary.
pub const ALIGNED: usize = 1 << 5;

/// Whether `features` contains the item `item`.
pub const fn has(features: usize, item: usize) -> bool {
    features & item != 0
}

/// One complex value, for the lanes that need scalar code.
#[derive(Clone, Copy)]
pub(crate) struct Complex {
    pub(crate) re: f32,
    pub(crate) im: f32
}

/// `len` floats on the heap; with `aligned` the first one sits on a 16-byte boundary (O10).
pub(crate) struct Buffer {
    data: Vec<f32>,
    offset: usize,
    len: usize
}

impl Buffer {
    pub(crate) fn new(len: usize, aligned: bool) -> Self {
        let data = vec![0.0; len + if aligned { 3 } else { 0 }];
        // In f32 steps: 0 to 3 values reach the next 16-byte boundary.
        let offset = if aligned { data.as_ptr().align_offset(16) } else { 0 };
        assert!(offset < 4, "no 16-byte boundary within the first four values");
        Self { data, offset, len }
    }

    pub(crate) fn from(values: &[f32], aligned: bool) -> Self {
        let mut buffer = Self::new(values.len(), aligned);
        buffer.get_mut().copy_from_slice(values);
        buffer
    }

    pub(crate) fn get(&self) -> &[f32] {
        &self.data[self.offset..self.offset + self.len]
    }

    pub(crate) fn get_mut(&mut self) -> &mut [f32] {
        &mut self.data[self.offset..self.offset + self.len]
    }
}

/// Split arrays behind raw pointers, so a stage can read and write the same buffer (O1 in place, O5).
#[derive(Clone, Copy)]
pub(crate) struct Shared {
    re: *mut f32,
    im: *mut f32,
    len: usize
}

impl Shared {
    pub(crate) fn new(re: &mut [f32], im: &mut [f32]) -> Self {
        assert_eq!(re.len(), im.len(), "re and im must have the same length");
        Self { re: re.as_mut_ptr(), im: im.as_mut_ptr(), len: re.len() }
    }

    /// The same memory with re and im exchanged: the inverse's swap trick.
    fn swapped(self) -> Self {
        Self { re: self.im, im: self.re, len: self.len }
    }

    /// # Safety
    /// No `&mut` to the memory is alive.
    pub(crate) unsafe fn re(&self) -> &[f32] {
        core::slice::from_raw_parts(self.re, self.len)
    }

    /// # Safety
    /// As `re`.
    pub(crate) unsafe fn im(&self) -> &[f32] {
        core::slice::from_raw_parts(self.im, self.len)
    }

    /// # Safety
    /// No other reference to the memory is alive.
    pub(crate) unsafe fn re_mut(&mut self) -> &mut [f32] {
        core::slice::from_raw_parts_mut(self.re, self.len)
    }

    /// # Safety
    /// As `re_mut`.
    pub(crate) unsafe fn im_mut(&mut self) -> &mut [f32] {
        core::slice::from_raw_parts_mut(self.im, self.len)
    }

    /// # Safety
    /// `index < len`.
    unsafe fn set(&mut self, index: usize, value: Complex) {
        (self.re_mut()[index], self.im_mut()[index]) = (value.re, value.im);
    }
}

impl Source for Shared {
    #[inline(always)]
    unsafe fn load(&self, index: usize) -> C4 {
        C4 { re: V4::load(self.re(), index), im: V4::load(self.im(), index) }
    }
}

impl Sink for Shared {
    #[inline(always)]
    unsafe fn store(&mut self, index: usize, value: C4) {
        value.re.store(self.re_mut(), index);
        value.im.store(self.im_mut(), index);
    }
}

/// Lane 0 of a vector, through a stack copy.
#[inline(always)]
fn lane_zero(value: C4) -> Complex {
    let (mut re, mut im) = ([0.0f32; 4], [0.0f32; 4]);
    // SAFETY: both arrays hold four values.
    unsafe {
        value.re.store(&mut re, 0);
        value.im.store(&mut im, 0);
    }
    Complex { re: re[0], im: im[0] }
}

/// The 8-point DFT with the forward sign (O2): 4-point DFTs E of the even and O of the odd inputs, then
/// y[r] = E[r] + W8^r·O[r] and y[r + 4] = E[r] − W8^r·O[r] with W8 = exp(−2πi/8).
#[inline(always)]
pub(crate) fn dft8(x: [C4; 8]) -> [C4; 8] {
    let [e0, e1, e2, e3] = butterfly(x[0], x[2], x[4], x[6]);
    let [o0, o1, o2, o3] = butterfly(x[1], x[3], x[5], x[7]);
    let h = V4::splat(FRAC_1_SQRT_2 as f32);
    // W8 = (1 − i)/√2, so (a + ib)·W8 = ((a + b) + i(b − a))/√2.
    let t1 = C4 { re: o1.re.add(o1.im).mul(h), im: o1.im.sub(o1.re).mul(h) };
    // W8³ = (−1 − i)/√2, so (a + ib)·W8³ = ((b − a) − i(a + b))/√2; its minus goes into y3 and y7.
    let (t3_re, t3_minus_im) = (o3.im.sub(o3.re).mul(h), o3.re.add(o3.im).mul(h));
    // W8² = −i, so (a + ib)·W8² = b − ia.
    [e0.add(o0), e1.add(t1), C4 { re: e2.re.add(o2.im), im: e2.im.sub(o2.re) }, C4 { re: e3.re.add(t3_re), im: e3.im.sub(t3_minus_im) },
        e0.sub(o0), e1.sub(t1), C4 { re: e2.re.sub(o2.im), im: e2.im.add(o2.re) }, C4 { re: e3.re.sub(t3_re), im: e3.im.add(t3_minus_im) }]
}

pub(crate) enum Stage {
    /// Splits each sub-transform of length `size / stride` into four of a quarter the length.
    Radix4 { stride: usize, twiddles: Buffer },
    /// Last stage when log2(size) is odd, without `RADIX8`: length-2 DFTs, no twiddles.
    Radix2,
    /// Last stage when log2(size) is odd, with `RADIX8`: length-8 DFTs, no table twiddles.
    Radix8
}

/// The stages of a size-`size` complex FFT with `features`.
pub(crate) fn plan(size: usize, features: usize) -> Vec<Stage> {
    let (mut stages, mut length) = (Vec::new(), size);
    while length >= 4 {
        if has(features, RADIX8) && length == 8 {
            stages.push(Stage::Radix8);
            return stages;
        }
        stages.push(Stage::Radix4 { stride: size / length, twiddles: Buffer::from(&stage_twiddles(length), has(features, ALIGNED)) });
        length /= 4;
    }
    if length == 2 {
        stages.push(Stage::Radix2);
    }
    stages
}

impl Stage {
    /// # Safety
    /// `from` and `to` hold `size` complex values.
    #[inline(always)]
    unsafe fn run<const FEATURES: usize, S: Source, D: Sink>(&self, size: usize, from: &S, to: &mut D) {
        match self {
            Stage::Radix4 { stride: 1, twiddles } => radix4_first(size, twiddles.get(), from, to),
            Stage::Radix4 { stride, twiddles } => radix4::<FEATURES, S, D>(size, *stride, twiddles.get(), from, to),
            Stage::Radix2 => radix2(size, from, to),
            // Without `RADIX8` the plan has no radix-8 stage; the guard keeps its code out of the build.
            Stage::Radix8 if has(FEATURES, RADIX8) => radix8(size, from, to),
            Stage::Radix8 => unreachable!("radix-8 stage without RADIX8")
        }
    }
}

/// As `simd`'s `radix4`; with `LOAD_SPLAT` the broadcast twiddles are one `load_splat` each (O4).
#[inline(always)]
unsafe fn radix4<const FEATURES: usize, S: Source, D: Sink>(size: usize, stride: usize, twiddles: &[f32], from: &S, to: &mut D) {
    let quarter = size / 4;
    let count = quarter / stride;
    let twiddle = |k: usize, p: usize| {
        let (re, im) = (2 * k * count + p, (2 * k + 1) * count + p);
        if has(FEATURES, LOAD_SPLAT) {
            C4 { re: V4::load_splat(twiddles, re), im: V4::load_splat(twiddles, im) }
        } else {
            C4 { re: V4::splat(twiddles[re]), im: V4::splat(twiddles[im]) }
        }
    };
    for q in (0..stride).step_by(4) {
        let [y0, y1, y2, y3] = butterfly(from.load(q), from.load(q + quarter), from.load(q + 2 * quarter), from.load(q + 3 * quarter));
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
            let [y0, y1, y2, y3] =
                butterfly(from.load(index), from.load(index + quarter), from.load(index + 2 * quarter), from.load(index + 3 * quarter));
            to.store(write + q, y0);
            to.store(write + q + stride, y1.mul(w1));
            to.store(write + q + 2 * stride, y2.mul(w2));
            to.store(write + q + 3 * stride, y3.mul(w3));
        }
    }
}

/// O2: length-8 DFTs at stride size/8, twiddle group p = 0 only.
#[inline(always)]
unsafe fn radix8<S: Source, D: Sink>(size: usize, from: &S, to: &mut D) {
    let stride = size / 8;
    for q in (0..stride).step_by(4) {
        let outputs = dft8(core::array::from_fn(|j| from.load(q + j * stride)));
        for (r, output) in outputs.into_iter().enumerate() {
            to.store(q + r * stride, output);
        }
    }
}

/// Outputs of butterflies q..q+3 of a last stage with radix `R` (2, 4 or 8) and twiddle group p = 0 only.
#[inline(always)]
unsafe fn last_outputs<const R: usize>(from: &Shared, q: usize, stride: usize) -> [C4; R] {
    let input = |j: usize| from.load(q + j * stride);
    match R {
        2 => {
            let (a, b) = (input(0), input(1));
            core::array::from_fn(|r| if r == 0 { a.add(b) } else { a.sub(b) })
        }
        4 => {
            let outputs = butterfly(input(0), input(1), input(2), input(3));
            core::array::from_fn(|r| outputs[r])
        }
        _ => {
            let outputs = dft8(core::array::from_fn(input));
            core::array::from_fn(|r| outputs[r])
        }
    }
}

/// U[k] for k in 0..=M/2 and the factor on the sum term, as `simd`'s `Twist`.
pub(crate) struct Twist {
    re: Buffer,
    im: Buffer,
    pub(crate) half: f32
}

impl Twist {
    /// Forward: U[k] = −i·W^k / 2 with W = exp(−2πi/N), half = 1/2. Inverse: conj(U[k]) and half, both / M.
    pub(crate) fn new(size: usize, inverse: bool, aligned: bool) -> Self {
        let m = size / 2;
        let scale = if inverse { 1.0 / m as f64 } else { 1.0 };
        let (mut re, mut im) = (vec![0.0; m / 2 + 1], vec![0.0; m / 2 + 1]);
        for k in 0..=m / 2 {
            let angle = 2.0 * PI * k as f64 / size as f64;
            // −i·(cos − i·sin) / 2 = (−sin − i·cos) / 2
            re[k] = (-0.5 * libm::sin(angle) * scale) as f32;
            im[k] = (if inverse { 0.5 } else { -0.5 } * libm::cos(angle) * scale) as f32;
        }
        Self { re: Buffer::from(&re, aligned), im: Buffer::from(&im, aligned), half: (0.5 * scale) as f32 }
    }

    /// # Safety
    /// `k + 4 <= M/2 + 1`.
    #[inline(always)]
    unsafe fn u(&self, k: usize) -> C4 {
        C4 { re: V4::load(self.re.get(), k), im: V4::load(self.im.get(), k) }
    }

    /// # Safety
    /// `k <= M/2`.
    #[inline(always)]
    pub(crate) unsafe fn u_splat(&self, k: usize) -> C4 {
        C4 { re: V4::load_splat(self.re.get(), k), im: V4::load_splat(self.im.get(), k) }
    }

    fn u_one(&self, k: usize) -> Complex {
        Complex { re: self.re.get()[k], im: self.im.get()[k] }
    }
}

/// One twist step on paired values: (X[k], X[M − k]) from Z[k], Z[M − k] and U[k], as in `simd`'s `twist` with
/// A = Z[k] + conj(Z[M − k]) and D = Z[k] − conj(Z[M − k]): X[k] = half·A + U·D, X[M − k] = conj(half·A − U·D).
#[inline(always)]
pub(crate) fn twist_pair(value: C4, other: C4, u: C4, half: V4) -> (C4, C4) {
    let sum = C4 { re: value.re.add(other.re), im: value.im.sub(other.im) };
    let difference = C4 { re: value.re.sub(other.re), im: value.im.add(other.im) };
    let (even, odd) = (sum.scale(half), difference.mul(u));
    (even.add(odd), C4 { re: even.re.sub(odd.re), im: odd.im.sub(even.im) })
}

/// `twist_pair` on blocks in memory order: `value` = Z[k..k+4], `mirror` = Z[M−k−3..M−k+1]. Returns X at the same
/// two places, also in memory order.
#[inline(always)]
fn twist_block(value: C4, mirror: C4, u: C4, half: V4) -> (C4, C4) {
    let (low, high) = twist_pair(value, mirror.reverse(), u, half);
    (low, high.reverse())
}

/// One lane of `twist_pair`, the same operations in the same order.
#[inline(always)]
fn twist_one(value: Complex, other: Complex, u: Complex, half: f32) -> (Complex, Complex) {
    let (sum_re, sum_im) = (value.re + other.re, value.im - other.im);
    let (difference_re, difference_im) = (value.re - other.re, value.im + other.im);
    let (even_re, even_im) = (sum_re * half, sum_im * half);
    let (odd_re, odd_im) = (difference_re * u.re - difference_im * u.im, difference_re * u.im + difference_im * u.re);
    (Complex { re: even_re + odd_re, im: even_im + odd_im }, Complex { re: even_re - odd_re, im: odd_im - even_im })
}

/// The unfused twist of `simd`, for the inverse without `FUSED_PRE_TWIST`.
///
/// # Safety
/// `from` holds at least M values, `to` M.
#[inline(always)]
unsafe fn twist(m: usize, table: &Twist, from: &Split, to: &mut Shared) {
    let half = V4::splat(table.half);
    for k in (1..=m / 2).step_by(4) {
        let mirror = m - k - 3;
        let (low, high) = twist_block(from.load(k), from.load(mirror), table.u(k), half);
        to.store(k, low);
        to.store(mirror, high);
    }
}

/// O1: the forward's last stage (radix R, stride s = M/R, twiddle group p = 0 only) fused with the twist. Butterfly
/// q writes Z[q + r·s], and the partner M − k of each output is output R − 1 − r of butterfly s − q. So block
/// q..q+3 runs together with block s−q−3..s−q and every twist pair is in registers. Butterfly 0 pairs with itself
/// (DC, Nyquist, M/2) and is done lane by lane. In place is allowed: each block pair reads all of its values first.
///
/// # Safety
/// `from` holds M values, `to` M + 1; `M / R >= 8`.
#[inline(always)]
unsafe fn last_with_twist<const R: usize>(m: usize, table: &Twist, from: Shared, mut to: Shared) {
    let stride = m / R;
    let half = V4::splat(table.half);
    let first = last_outputs::<R>(&from, 0, stride);
    let z: [Complex; R] = core::array::from_fn(|r| lane_zero(first[r]));
    to.set(0, Complex { re: z[0].re + z[0].im, im: 0.0 });
    to.set(m, Complex { re: z[0].re - z[0].im, im: 0.0 });
    for r in 1..R / 2 {
        let (low, high) = twist_one(z[r], z[R - r], table.u_one(r * stride), table.half);
        to.set(r * stride, low);
        to.set(m - r * stride, high);
    }
    // As in `simd`, M/2 keeps the conjugate form, which its twist writes last.
    to.set(m / 2, twist_one(z[R / 2], z[R / 2], table.u_one(m / 2), table.half).1);
    for q in (1..=stride / 2 - 3).step_by(4) {
        let mirror = stride - q - 3;
        let (block, other) = (last_outputs::<R>(&from, q, stride), last_outputs::<R>(&from, mirror, stride));
        for r in 0..R / 2 {
            // Output r of the block pairs with output R−1−r of the mirror block, and the other way round.
            let (low, high) = (q + r * stride, mirror + r * stride);
            let (block_low, other_high) = twist_block(block[r], other[R - 1 - r], table.u(low), half);
            let (other_low, block_high) = twist_block(other[r], block[R - 1 - r], table.u(high), half);
            to.store(low, block_low);
            to.store(m - low - 3, other_high);
            to.store(high, other_low);
            to.store(m - high - 3, block_high);
        }
    }
}

/// Butterflies p..p+3 of the inverse's first stage from its inputs Z'[p + j·M/4], as `radix4_first` does on the
/// swapped view (re and im exchanged).
///
/// # Safety
/// `to` holds M values, `p + 4 <= M/4`.
#[inline(always)]
unsafe fn first_block(quarter: usize, twiddles: &[f32], p: usize, inputs: [C4; 4], to: &mut Shared) {
    let swap = |value: C4| C4 { re: value.im, im: value.re };
    let twiddle = |k: usize| C4 { re: V4::load(twiddles, 2 * k * quarter + p), im: V4::load(twiddles, (2 * k + 1) * quarter + p) };
    let [y0, y1, y2, y3] = butterfly(swap(inputs[0]), swap(inputs[1]), swap(inputs[2]), swap(inputs[3]));
    let (y1, y2, y3) = (y1.mul(twiddle(0)), y2.mul(twiddle(1)), y3.mul(twiddle(2)));
    let [re0, re1, re2, re3] = transpose([y0.re, y1.re, y2.re, y3.re]);
    let [im0, im1, im2, im3] = transpose([y0.im, y1.im, y2.im, y3.im]);
    to.store(4 * p, C4 { re: re0, im: im0 });
    to.store(4 * p + 4, C4 { re: re1, im: im1 });
    to.store(4 * p + 8, C4 { re: re2, im: im2 });
    to.store(4 * p + 12, C4 { re: re3, im: im3 });
}

/// O3: the inverse's pre-twist fused into its first stage. The first stage reads Z'[p + j·Q] (Q = M/4), and the
/// partner M − k of each is input 3 − j of butterfly Q − p. So block p..p+3 runs together with block Q−p−3..Q−p.
/// Butterflies 0..3 take values computed lane by lane, since butterfly 0 holds DC (index 0) and M/2.
///
/// # Safety
/// `from` holds M + 1 bins, `to` M values, `M/4 >= 32`.
#[inline(always)]
unsafe fn first_with_pre_twist(m: usize, table: &Twist, twiddles: &[f32], from: &Split, to: &mut Shared) {
    let (quarter, half) = (m / 4, V4::splat(table.half));
    let bin = |index: usize| Complex { re: from.re[index], im: from.im[index] };
    // Z'[index] as `simd`'s pre-twist leaves it: DC apart, the plain form below M/2, the conjugate form from M/2 up.
    let pre_twisted = |index: usize| {
        if index == 0 {
            Complex { re: table.half * (from.re[0] + from.re[m]), im: table.half * (from.re[0] - from.re[m]) }
        } else if index < m / 2 {
            twist_one(bin(index), bin(m - index), table.u_one(index), table.half).0
        } else {
            twist_one(bin(m - index), bin(index), table.u_one(m - index), table.half).1
        }
    };
    let corner: [C4; 4] = core::array::from_fn(|j| {
        let values: [Complex; 4] = core::array::from_fn(|lane| pre_twisted(lane + j * quarter));
        let (re, im) = (values.map(|value| value.re), values.map(|value| value.im));
        C4 { re: V4::load(&re, 0), im: V4::load(&im, 0) }
    });
    first_block(quarter, twiddles, 0, corner, to);
    for p in (1..=quarter / 2 - 3).step_by(4) {
        let mirror = quarter - p - 3;
        // Pair j: block input j with mirror input 3 − j, and mirror input j with block input 3 − j (j = 0, 1).
        let pair = |k: usize| twist_block(from.load(k), from.load(m - k - 3), table.u(k), half);
        let (block0, other3) = pair(p);
        let (block1, other2) = pair(p + quarter);
        let (other0, block3) = pair(mirror);
        let (other1, block2) = pair(mirror + quarter);
        first_block(quarter, twiddles, p, [block0, block1, block2, block3], to);
        first_block(quarter, twiddles, mirror, [other0, other1, other2, other3], to);
    }
}

struct Work {
    re: Buffer,
    im: Buffer
}

impl Work {
    fn new(size: usize, aligned: bool) -> Self {
        Self { re: Buffer::new(size, aligned), im: Buffer::new(size, aligned) }
    }

    fn shared(&mut self) -> Shared {
        Shared::new(self.re.get_mut(), self.im.get_mut())
    }
}

/// Real-input FFT of one power-of-two size N >= 256 with the outlook items in `FEATURES` (`FUSED_TWIST` required). Same
/// contract as `simd`: N/2 + 1 unnormalised bins, the inverse undoes it exactly.
pub struct RealFft<const FEATURES: usize> {
    size: usize,
    stages: Vec<Stage>,
    forward_twist: Twist,
    inverse_twist: Twist,
    work: Vec<Work>
}

impl<const FEATURES: usize> RealFft<FEATURES> {
    pub fn new(size: usize) -> Self {
        assert!(size.is_power_of_two() && size >= 256, "size must be a power of two >= 256");
        assert!(has(FEATURES, FUSED_TWIST), "the forward needs FUSED_TWIST");
        let (m, aligned) = (size / 2, has(FEATURES, ALIGNED));
        let buffers = if has(FEATURES, CALLER_BUFFERS) { 1 } else { 2 };
        Self { size, stages: plan(m, FEATURES), forward_twist: Twist::new(size, false, aligned), inverse_twist: Twist::new(size, true, aligned),
            work: (0..buffers).map(|_| Work::new(m, aligned)).collect() }
    }

    pub fn size(&self) -> usize {
        self.size
    }

    /// The two buffers a stage alternates between: both work buffers, or with `CALLER_BUFFERS` the one
    /// work buffer and `spare`.
    fn buffers(&mut self, spare: Shared) -> (Shared, Shared) {
        let first = self.work[0].shared();
        (first, if has(FEATURES, CALLER_BUFFERS) { spare } else { self.work[1].shared() })
    }

    pub fn forward(&mut self, input: &[f32], re: &mut [f32], im: &mut [f32]) {
        let (m, last) = (self.size / 2, self.stages.len() - 1);
        assert!(input.len() == self.size && re.len() > m && im.len() > m, "buffer lengths do not match the size");
        let caller = Shared::new(&mut re[..=m], &mut im[..=m]);
        let (work, other) = self.buffers(caller);
        // Stage `index` writes here. With `CALLER_BUFFERS`, the stage before the last writes the caller's
        // buffers, and the fused last stage runs there in place.
        let target = |index: usize| {
            let first = if has(FEATURES, CALLER_BUFFERS) { (last - 1 - index) % 2 == 1 } else { index % 2 == 0 };
            if first { work } else { other }
        };
        // SAFETY: `input` holds 2M samples, `re`/`im` M + 1 bins (asserted), the work buffers M values; each stage
        // reads one buffer and writes the other.
        unsafe {
            self.stages[0].run::<FEATURES, _, _>(m, &Packed(input), &mut target(0));
            for index in 1..last {
                self.stages[index].run::<FEATURES, _, _>(m, &target(index - 1), &mut target(index));
            }
            let from = target(last - 1);
            match self.stages[last] {
                Stage::Radix2 => last_with_twist::<2>(m, &self.forward_twist, from, caller),
                Stage::Radix4 { .. } => last_with_twist::<4>(m, &self.forward_twist, from, caller),
                Stage::Radix8 if has(FEATURES, RADIX8) => last_with_twist::<8>(m, &self.forward_twist, from, caller),
                Stage::Radix8 => unreachable!("radix-8 stage without RADIX8")
            }
        }
    }

    pub fn inverse(&mut self, re: &[f32], im: &[f32], output: &mut [f32]) {
        let (m, last) = (self.size / 2, self.stages.len() - 1);
        assert!(output.len() == self.size && re.len() > m && im.len() > m, "buffer lengths do not match the size");
        let (left, right) = output.split_at_mut(m);
        let (work, other) = self.buffers(Shared::new(left, right));
        // With `CALLER_BUFFERS`, the output doubles as a work buffer; the last stage must read the other one.
        let target = |index: usize| {
            let first = if has(FEATURES, CALLER_BUFFERS) { (last - 1 - index) % 2 == 0 } else { index % 2 == 0 };
            if first { work } else { other }
        };
        let spectrum = Split { re, im };
        // SAFETY: `re`/`im` hold M + 1 bins, `output` 2M samples (asserted), the work buffers M values.
        unsafe {
            if has(FEATURES, FUSED_PRE_TWIST) {
                let Stage::Radix4 { twiddles, .. } = &self.stages[0] else { unreachable!("the first stage is radix-4") };
                first_with_pre_twist(m, &self.inverse_twist, twiddles.get(), &spectrum, &mut target(0));
            } else {
                // Without `CALLER_BUFFERS` there are two work buffers; stage 0 writes the first, so the pre-twist uses the second.
                let mut twisted = other;
                twist(m, &self.inverse_twist, &spectrum, &mut twisted);
                let half = self.inverse_twist.half;
                twisted.set(0, Complex { re: half * (re[0] + re[m]), im: half * (re[0] - re[m]) });
                self.stages[0].run::<FEATURES, _, _>(m, &twisted.swapped(), &mut target(0));
            }
            for index in 1..last {
                self.stages[index].run::<FEATURES, _, _>(m, &target(index - 1), &mut target(index));
            }
            self.stages[last].run::<FEATURES, _, _>(m, &target(last - 1), &mut Unpacked(output));
        }
    }
}
