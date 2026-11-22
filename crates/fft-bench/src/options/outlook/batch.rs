//! O6 of `docs/simd-outlook.md`: four real FFTs of one size at once, lane j holding signal j. Every value is
//! interleaved by signal (`x0[n] x1[n] x2[n] x3[n]`), so element k is one `v128` at float index 4k and each stage is
//! the scalar algorithm with `V4` in place of `f32`: no transposes, no reversals. Has every item of
//! `kernel::RealFft` at O10 and the same operations per lane, so each lane gives that kernel's bits.

use super::kernel::{dft8, plan, twist_pair, Buffer, Shared, Stage, Twist, ALIGNED, RADIX8};
use crate::options::simd::kernel::{butterfly, Sink, Source, C4};
use crate::options::simd::v4::V4;
use alloc::vec::Vec;

pub const LANES: usize = 4;

/// Split arrays of elements: complex value k of all four signals at float index 4k.
#[derive(Clone, Copy)]
struct Elements(Shared);

impl Source for Elements {
    #[inline(always)]
    unsafe fn load(&self, index: usize) -> C4 {
        C4 { re: V4::load(self.0.re(), LANES * index), im: V4::load(self.0.im(), LANES * index) }
    }
}

impl Sink for Elements {
    #[inline(always)]
    unsafe fn store(&mut self, index: usize, value: C4) {
        value.re.store(self.0.re_mut(), LANES * index);
        value.im.store(self.0.im_mut(), LANES * index);
    }
}

/// A read-only spectrum, element by element.
struct Spectrum<'a> {
    re: &'a [f32],
    im: &'a [f32]
}

impl Source for Spectrum<'_> {
    #[inline(always)]
    unsafe fn load(&self, index: usize) -> C4 {
        C4 { re: V4::load(self.re, LANES * index), im: V4::load(self.im, LANES * index) }
    }
}

/// Interleaved real samples read as complex elements z[j] = x[2j] + i·x[2j + 1].
struct Packed<'a>(&'a [f32]);

impl Source for Packed<'_> {
    #[inline(always)]
    unsafe fn load(&self, index: usize) -> C4 {
        C4 { re: V4::load(self.0, 2 * LANES * index), im: V4::load(self.0, 2 * LANES * index + LANES) }
    }
}

/// The inverse's swapped view written back as interleaved real samples: x[2j] = im, x[2j + 1] = re.
struct Unpacked<'a>(&'a mut [f32]);

impl Sink for Unpacked<'_> {
    #[inline(always)]
    unsafe fn store(&mut self, index: usize, value: C4) {
        value.im.store(self.0, 2 * LANES * index);
        value.re.store(self.0, 2 * LANES * index + LANES);
    }
}

/// One radix-4 stage per element. As in `simd`, the first stage (stride 1) multiplies group p = 0 by its twiddles
/// (all 1) and the later ones skip that multiply, so the bits match.
#[inline(always)]
unsafe fn radix4<S: Source, D: Sink>(size: usize, stride: usize, twiddles: &[f32], from: &S, to: &mut D) {
    let quarter = size / 4;
    let count = quarter / stride;
    let twiddle = |k: usize, p: usize| C4 {
        re: V4::load_splat(twiddles, 2 * k * count + p),
        im: V4::load_splat(twiddles, (2 * k + 1) * count + p)
    };
    let first = if stride == 1 { 0 } else { 1 };
    if stride > 1 {
        for q in 0..stride {
            let [y0, y1, y2, y3] = butterfly(from.load(q), from.load(q + quarter), from.load(q + 2 * quarter), from.load(q + 3 * quarter));
            to.store(q, y0);
            to.store(q + stride, y1);
            to.store(q + 2 * stride, y2);
            to.store(q + 3 * stride, y3);
        }
    }
    for p in first..count {
        let (w1, w2, w3) = (twiddle(0, p), twiddle(1, p), twiddle(2, p));
        let (read, write) = (stride * p, 4 * stride * p);
        for q in 0..stride {
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

/// Outputs of butterfly q of a last stage with radix `R` (4 or 8), twiddle group p = 0 only.
#[inline(always)]
unsafe fn last_outputs<const R: usize, S: Source>(from: &S, q: usize, stride: usize) -> [C4; R] {
    let input = |j: usize| from.load(q + j * stride);
    if R == 4 {
        let outputs = butterfly(input(0), input(1), input(2), input(3));
        core::array::from_fn(|r| outputs[r])
    } else {
        let outputs = dft8(core::array::from_fn(input));
        core::array::from_fn(|r| outputs[r])
    }
}

#[inline(always)]
unsafe fn run<S: Source, D: Sink>(stage: &Stage, size: usize, from: &S, to: &mut D) {
    match stage {
        Stage::Radix4 { stride, twiddles } => radix4(size, *stride, twiddles.get(), from, to),
        Stage::Radix8 => {
            let stride = size / 8;
            for q in 0..stride {
                for (r, output) in last_outputs::<8, S>(from, q, stride).into_iter().enumerate() {
                    to.store(q + r * stride, output);
                }
            }
        }
        Stage::Radix2 => unreachable!("with RADIX8 there is no radix-2 stage")
    }
}

/// O1 per element: the last stage fused with the twist. Butterfly q pairs with butterfly s − q (output r with
/// output R − 1 − r); butterfly 0 pairs with itself. No reversal: each lane is its own transform.
///
/// # Safety
/// `from` holds M elements, `to` M + 1; they may be the same buffer.
#[inline(always)]
unsafe fn last_with_twist<const R: usize>(m: usize, table: &Twist, from: Elements, mut to: Elements) {
    let stride = m / R;
    let half = V4::splat(table.half);
    let z = last_outputs::<R, _>(&from, 0, stride);
    let zero = V4::splat(0.0);
    to.store(0, C4 { re: z[0].re.add(z[0].im), im: zero });
    to.store(m, C4 { re: z[0].re.sub(z[0].im), im: zero });
    for r in 1..R / 2 {
        let (low, high) = twist_pair(z[r], z[R - r], table.u_splat(r * stride), half);
        to.store(r * stride, low);
        to.store(m - r * stride, high);
    }
    to.store(m / 2, twist_pair(z[R / 2], z[R / 2], table.u_splat(m / 2), half).1);
    for q in 1..=stride / 2 {
        let mirror = stride - q;
        let (block, other) = (last_outputs::<R, _>(&from, q, stride), last_outputs::<R, _>(&from, mirror, stride));
        for r in 0..R / 2 {
            let (low, high) = (q + r * stride, mirror + r * stride);
            let (block_low, other_high) = twist_pair(block[r], other[R - 1 - r], table.u_splat(low), half);
            let (other_low, block_high) = twist_pair(other[r], block[R - 1 - r], table.u_splat(high), half);
            to.store(low, block_low);
            to.store(m - low, other_high);
            to.store(high, other_low);
            to.store(m - high, block_high);
        }
    }
}

/// Butterfly p of the inverse's first stage from its inputs Z'[p + j·M/4], on the swapped view.
#[inline(always)]
unsafe fn first_element(quarter: usize, twiddles: &[f32], p: usize, inputs: [C4; 4], to: &mut Elements) {
    let swap = |value: C4| C4 { re: value.im, im: value.re };
    let twiddle = |k: usize| C4 { re: V4::load_splat(twiddles, 2 * k * quarter + p), im: V4::load_splat(twiddles, (2 * k + 1) * quarter + p) };
    let [y0, y1, y2, y3] = butterfly(swap(inputs[0]), swap(inputs[1]), swap(inputs[2]), swap(inputs[3]));
    to.store(4 * p, y0);
    to.store(4 * p + 1, y1.mul(twiddle(0)));
    to.store(4 * p + 2, y2.mul(twiddle(1)));
    to.store(4 * p + 3, y3.mul(twiddle(2)));
}

/// O3 per element: the pre-twist fused into the first stage. Butterfly p pairs with butterfly Q − p (input j with
/// input 3 − j); butterfly 0 holds DC and M/2.
///
/// # Safety
/// `from` holds M + 1 elements, `to` M.
#[inline(always)]
unsafe fn first_with_pre_twist(m: usize, table: &Twist, twiddles: &[f32], from: &Spectrum, to: &mut Elements) {
    let (quarter, half) = (m / 4, V4::splat(table.half));
    let pair = |k: usize| twist_pair(from.load(k), from.load(m - k), table.u_splat(k), half);
    let (dc, nyquist) = (from.load(0), from.load(m));
    let corner = C4 { re: half.mul(dc.re.add(nyquist.re)), im: half.mul(dc.re.sub(nyquist.re)) };
    let (low, high) = pair(quarter);
    let middle = from.load(m / 2);
    first_element(quarter, twiddles, 0, [corner, low, twist_pair(middle, middle, table.u_splat(m / 2), half).1, high], to);
    for p in 1..=quarter / 2 {
        let mirror = quarter - p;
        let (block0, other3) = pair(p);
        let (block1, other2) = pair(p + quarter);
        let (other0, block3) = pair(mirror);
        let (other1, block2) = pair(mirror + quarter);
        first_element(quarter, twiddles, p, [block0, block1, block2, block3], to);
        first_element(quarter, twiddles, mirror, [other0, other1, other2, other3], to);
    }
}

/// Four real FFTs of one power-of-two size N >= 256 per call, interleaved by signal: `forward` takes 4N samples and
/// writes 4(N/2 + 1) bins per array; `inverse` undoes it exactly.
pub struct RealFft4 {
    size: usize,
    stages: Vec<Stage>,
    forward_twist: Twist,
    inverse_twist: Twist,
    work_re: Buffer,
    work_im: Buffer
}

impl RealFft4 {
    pub fn new(size: usize) -> Self {
        assert!(size.is_power_of_two() && size >= 256, "size must be a power of two >= 256");
        let m = size / 2;
        Self { size, stages: plan(m, RADIX8 | ALIGNED), forward_twist: Twist::new(size, false, true), inverse_twist: Twist::new(size, true, true),
            work_re: Buffer::new(LANES * m, true), work_im: Buffer::new(LANES * m, true) }
    }

    pub fn size(&self) -> usize {
        self.size
    }

    fn work(&mut self) -> Elements {
        Elements(Shared::new(self.work_re.get_mut(), self.work_im.get_mut()))
    }

    pub fn forward(&mut self, input: &[f32], re: &mut [f32], im: &mut [f32]) {
        let (m, last) = (self.size / 2, self.stages.len() - 1);
        assert!(input.len() == LANES * self.size && re.len() >= LANES * (m + 1) && im.len() >= LANES * (m + 1), "buffer lengths do not match the size");
        let caller = Elements(Shared::new(&mut re[..LANES * (m + 1)], &mut im[..LANES * (m + 1)]));
        let work = self.work();
        // O5: the stage before the last writes the caller's buffers; the fused last stage runs there in place.
        let target = |index: usize| if (last - 1 - index) % 2 == 0 { caller } else { work };
        // SAFETY: lengths asserted above; each stage reads one buffer and writes the other.
        unsafe {
            run(&self.stages[0], m, &Packed(input), &mut target(0));
            for index in 1..last {
                run(&self.stages[index], m, &target(index - 1), &mut target(index));
            }
            match self.stages[last] {
                Stage::Radix8 => last_with_twist::<8>(m, &self.forward_twist, caller, caller),
                _ => last_with_twist::<4>(m, &self.forward_twist, caller, caller)
            }
        }
    }

    pub fn inverse(&mut self, re: &[f32], im: &[f32], output: &mut [f32]) {
        let (m, last) = (self.size / 2, self.stages.len() - 1);
        assert!(output.len() == LANES * self.size && re.len() >= LANES * (m + 1) && im.len() >= LANES * (m + 1), "buffer lengths do not match the size");
        let (left, right) = output.split_at_mut(LANES * m);
        let spare = Elements(Shared::new(left, right));
        let work = self.work();
        // O5: the output doubles as a work buffer; the last stage reads the work buffer and writes the output.
        let target = |index: usize| if (last - 1 - index) % 2 == 0 { work } else { spare };
        // SAFETY: lengths asserted above; each stage reads one buffer and writes the other.
        unsafe {
            let spectrum = Spectrum { re, im };
            let Stage::Radix4 { twiddles, .. } = &self.stages[0] else { unreachable!("the first stage is radix-4") };
            first_with_pre_twist(m, &self.inverse_twist, twiddles.get(), &spectrum, &mut target(0));
            for index in 1..last {
                run(&self.stages[index], m, &target(index - 1), &mut target(index));
            }
            run(&self.stages[last], m, &target(last - 1), &mut Unpacked(output));
        }
    }
}
