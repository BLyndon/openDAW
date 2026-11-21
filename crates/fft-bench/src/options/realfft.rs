//! `realfft` 3.5 over `rustfft` 6.4, the library alternative from `future-plans/simd-fft.md`. Open gate
//! questions: third-party DSP and `std` in a `no_std` engine. Interleaved `Complex<f32>` and the
//! unnormalized inverse are adapted.

use crate::{bins, RealFft};
use ::realfft::num_complex::Complex;
use ::realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use std::sync::Arc;

pub struct RealFftOption {
    n: usize,
    forward_plan: Arc<dyn RealToComplex<f32>>,
    inverse_plan: Arc<dyn ComplexToReal<f32>>,
    input: Vec<f32>,
    spectrum: Vec<Complex<f32>>,
    output: Vec<f32>,
    forward_scratch: Vec<Complex<f32>>,
    inverse_scratch: Vec<Complex<f32>>
}

impl RealFft for RealFftOption {
    fn new(n: usize) -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        let forward_plan = planner.plan_fft_forward(n);
        let inverse_plan = planner.plan_fft_inverse(n);
        let (forward_scratch, inverse_scratch) = (forward_plan.make_scratch_vec(), inverse_plan.make_scratch_vec());
        Self { n, forward_plan, inverse_plan, input: vec![0.0; n], spectrum: vec![Complex::new(0.0, 0.0); bins(n)],
            output: vec![0.0; n], forward_scratch, inverse_scratch }
    }

    fn size(&self) -> usize {
        self.n
    }

    fn forward(&mut self, input: &[f32], re: &mut [f32], im: &mut [f32]) {
        self.prepare_forward(input);
        self.forward_kernel(input, re, im);
        for (bin, value) in self.spectrum.iter().enumerate() {
            re[bin] = value.re;
            im[bin] = value.im;
        }
    }

    fn inverse(&mut self, re: &[f32], im: &[f32], output: &mut [f32]) -> bool {
        self.prepare_inverse(re, im);
        self.inverse_kernel(re, im, output);
        let scale = 1.0 / self.n as f32;
        for (target, value) in output.iter_mut().zip(&self.output) {
            *target = value * scale;
        }
        true
    }

    /// realfft uses its input as scratch, so it gets a copy.
    fn prepare_forward(&mut self, input: &[f32]) {
        self.input.copy_from_slice(input);
    }

    fn forward_kernel(&mut self, _input: &[f32], _re: &mut [f32], _im: &mut [f32]) {
        self.forward_plan.process_with_scratch(&mut self.input, &mut self.spectrum, &mut self.forward_scratch)
            .expect("buffer lengths are fixed at plan creation");
    }

    fn prepare_inverse(&mut self, re: &[f32], im: &[f32]) {
        let last = self.n / 2;
        for (bin, value) in self.spectrum.iter_mut().enumerate() {
            *value = Complex::new(re[bin], im[bin]);
        }
        // DC and Nyquist of a real signal have no imaginary part; realfft rejects non-zero values there.
        self.spectrum[0].im = 0.0;
        self.spectrum[last].im = 0.0;
    }

    /// Unscaled, as the library returns it; the 1/n is left to the caller (it can be folded into a window).
    fn inverse_kernel(&mut self, _re: &[f32], _im: &[f32], _output: &mut [f32]) -> bool {
        self.inverse_plan.process_with_scratch(&mut self.spectrum, &mut self.output, &mut self.inverse_scratch)
            .expect("buffer lengths are fixed and DC/Nyquist imaginary parts are zero");
        true
    }
}
