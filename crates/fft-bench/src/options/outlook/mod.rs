//! Prototypes for the outlook (`docs/simd-outlook.md`). The stages S0 (`simd`), O1, O2, O3, O4, O5, O10 (`kernel`)
//! and O6 (`batch`) each have every item before them; `S0+O1+O4` has only the two items that paid in Chrome.
//! Measured on the stages page (`web/stages.html`), not on the decision page.

pub mod batch;
pub mod kernel;

use super::simd::SimdRealFft;
use crate::{bins, RealFft};
use batch::{RealFft4, LANES};
use kernel::{Buffer, ALIGNED, CALLER_BUFFERS, FUSED_PRE_TWIST, FUSED_TWIST, LOAD_SPLAT, RADIX8};

const O1: usize = FUSED_TWIST;
const O2: usize = O1 | RADIX8;
const O3: usize = O2 | FUSED_PRE_TWIST;
const O4: usize = O3 | LOAD_SPLAT;
const O5: usize = O4 | CALLER_BUFFERS;
const O10: usize = O5 | ALIGNED;

pub struct StageEntry {
    /// Outlook item, as on the chart's x-axis.
    pub name: &'static str,
    /// Transforms per call: the stages page divides the time per call by this.
    pub batch: usize,
    pub create: fn(usize) -> Box<dyn RealFft>
}

fn create<T: RealFft + 'static>(n: usize) -> Box<dyn RealFft> {
    Box::new(T::new(n))
}

/// Every stage, in the order the items are added, then the selection `S0+O1+O4`.
pub const STAGES: [StageEntry; 9] = [
    StageEntry { name: "S0", batch: 1, create: create::<SimdRealFft> },
    StageEntry { name: "O1", batch: 1, create: create::<Outlook<O1>> },
    StageEntry { name: "O2", batch: 1, create: create::<Outlook<O2>> },
    StageEntry { name: "O3", batch: 1, create: create::<Outlook<O3>> },
    StageEntry { name: "O4", batch: 1, create: create::<Outlook<O4>> },
    StageEntry { name: "O5", batch: 1, create: create::<Outlook<O5>> },
    StageEntry { name: "O10", batch: 1, create: create::<Outlook<O10>> },
    StageEntry { name: "O6", batch: LANES, create: create::<Batch> },
    StageEntry { name: "S0+O1+O4", batch: 1, create: create::<Selection> }
];

/// `simd` with O1 and O4 only, the two items that paid in Chrome; also the option `simd-o1o4` of `options::ALL`.
pub type Selection = Outlook<{ FUSED_TWIST | LOAD_SPLAT }>;

pub struct Outlook<const FEATURES: usize>(kernel::RealFft<FEATURES>);

impl<const FEATURES: usize> RealFft for Outlook<FEATURES> {
    fn new(n: usize) -> Self {
        Self(kernel::RealFft::new(n))
    }

    fn size(&self) -> usize {
        self.0.size()
    }

    fn forward(&mut self, input: &[f32], re: &mut [f32], im: &mut [f32]) {
        self.0.forward(input, re, im)
    }

    fn inverse(&mut self, re: &[f32], im: &[f32], output: &mut [f32]) -> bool {
        self.0.inverse(re, im, output);
        true
    }
}

/// O6 behind the one-transform interface: `prepare_*` copies the signal into all four lanes (untimed), the kernels
/// run on the interleaved buffers, and `forward`/`inverse` return lane 0. The timed call does four transforms.
pub struct Batch {
    fft: RealFft4,
    input: Buffer,
    re: Buffer,
    im: Buffer,
    output: Buffer
}

fn interleave(from: &[f32], to: &mut [f32]) {
    for (index, value) in from.iter().enumerate() {
        to[LANES * index..LANES * (index + 1)].fill(*value);
    }
}

fn lane_zero(from: &[f32], to: &mut [f32]) {
    for (index, value) in to.iter_mut().enumerate() {
        *value = from[LANES * index];
    }
}

impl RealFft for Batch {
    fn new(n: usize) -> Self {
        let lanes = |count: usize| Buffer::new(LANES * count, true);
        Self { fft: RealFft4::new(n), input: lanes(n), re: lanes(bins(n)), im: lanes(bins(n)), output: lanes(n) }
    }

    fn size(&self) -> usize {
        self.fft.size()
    }

    fn forward(&mut self, input: &[f32], re: &mut [f32], im: &mut [f32]) {
        self.prepare_forward(input);
        self.forward_kernel(input, re, im);
        lane_zero(self.re.get(), &mut re[..bins(self.size())]);
        lane_zero(self.im.get(), &mut im[..bins(self.size())]);
    }

    fn inverse(&mut self, re: &[f32], im: &[f32], output: &mut [f32]) -> bool {
        self.prepare_inverse(re, im);
        self.inverse_kernel(re, im, output);
        lane_zero(self.output.get(), output);
        true
    }

    fn prepare_forward(&mut self, input: &[f32]) {
        interleave(input, self.input.get_mut());
    }

    fn forward_kernel(&mut self, _input: &[f32], _re: &mut [f32], _im: &mut [f32]) {
        self.fft.forward(self.input.get(), self.re.get_mut(), self.im.get_mut());
    }

    fn prepare_inverse(&mut self, re: &[f32], im: &[f32]) {
        let count = bins(self.size());
        interleave(&re[..count], self.re.get_mut());
        interleave(&im[..count], self.im.get_mut());
    }

    fn inverse_kernel(&mut self, _re: &[f32], _im: &[f32], _output: &mut [f32]) -> bool {
        self.fft.inverse(self.re.get(), self.im.get(), self.output.get_mut());
        true
    }
}
