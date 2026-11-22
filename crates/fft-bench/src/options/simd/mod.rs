//! The Day-2 prototype: radix-4 Stockham with SIMD128 butterflies (`kernel`), as a real-input FFT (`simd`)
//! and as a full complex FFT (`simd-complex`, the shape `signalsmith` has). Natively the kernel runs its
//! scalar `[f32; 4]` fallback, a bit-exact oracle for the wasm build, not a speed reference.

pub mod kernel;
pub(crate) mod v4;

use super::complex::{ComplexAsReal, ComplexFft};
use crate::RealFft;

pub struct SimdRealFft(kernel::RealFft);

impl RealFft for SimdRealFft {
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

pub type SimdComplexFft = ComplexAsReal<kernel::Fft>;

impl ComplexFft for kernel::Fft {
    fn new(n: usize) -> Self {
        kernel::Fft::new(n)
    }

    fn size(&self) -> usize {
        kernel::Fft::size(self)
    }

    fn forward(&mut self, re: &mut [f32], im: &mut [f32]) {
        kernel::Fft::forward(self, re, im)
    }

    fn inverse(&mut self, re: &mut [f32], im: &mut [f32]) {
        kernel::Fft::inverse(self, re, im)
    }

    fn steps(&self) -> usize {
        self.stages()
    }

    fn step(&mut self, re: &mut [f32], im: &mut [f32], step: usize) {
        self.stage(re, im, step, false);
    }
}
