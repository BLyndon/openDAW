//! `signalsmith::fft` as of `7998a6b64`, the SIMD pass reverted in `3628e040e`: 4 butterflies per `f32x4`
//! from distance 4 on, stages 1–2 and bit reversal scalar, strided twiddles gathered per lane. Kept to test
//! the revert's hypothesis (browser audio-thread tier vs Node). Natively it runs the scalar `Simd4` fallback.

mod fft;
mod simd;

use super::complex::{ComplexAsReal, ComplexFft};
pub use fft::Fft;

pub type RevertedFft = ComplexAsReal<Fft>;

impl ComplexFft for Fft {
    fn new(n: usize) -> Self {
        Fft::new(n)
    }

    fn size(&self) -> usize {
        Fft::size(self)
    }

    fn forward(&mut self, re: &mut [f32], im: &mut [f32]) {
        Fft::forward(self, re, im)
    }

    fn inverse(&mut self, re: &mut [f32], im: &mut [f32]) {
        Fft::inverse(self, re, im)
    }
}
