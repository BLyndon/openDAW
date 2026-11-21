//! `signalsmith::fft::Fft`, the third scalar baseline: a full N-point complex FFT used by the time-stretch
//! (one per playing region, N = 4096), fed with real input through `ComplexAsReal`.

use super::complex::{ComplexAsReal, ComplexFft};
use signalsmith::fft::Fft;

pub type SignalsmithFft = ComplexAsReal<Fft>;

impl ComplexFft for Fft {
    fn new(n: usize) -> Self {
        Fft::new(n)
    }

    fn size(&self) -> usize {
        Fft::size(self)
    }

    fn forward(&self, re: &mut [f32], im: &mut [f32]) {
        Fft::forward(self, re, im)
    }

    fn inverse(&self, re: &mut [f32], im: &mut [f32]) {
        Fft::inverse(self, re, im)
    }

    /// As `SignalsmithStretch::frame_step` runs a forward FFT: bit reversal, then one stage per step.
    fn steps(&self) -> usize {
        1 + self.stages()
    }

    fn step(&self, re: &mut [f32], im: &mut [f32], step: usize) {
        if step == 0 {
            self.bit_reverse(re, im);
        } else {
            self.stage(re, im, step - 1, false);
        }
    }
}
