//! Adapter that runs a full N-point complex FFT on one real signal: `im = 0` before `forward`, a Hermitian
//! mirror before `inverse`. The transform costs the same whatever `im` holds, so the timing stands for the
//! complex FFT itself. (`SignalsmithStretch` fills `im` with the right channel instead, so it transforms
//! two real channels per call; that is its consumer's business, not the FFT's.)

use crate::{bins, RealFft};

/// An in-place complex FFT on split arrays; `inverse` scales by 1/n.
pub trait ComplexFft {
    fn new(n: usize) -> Self;
    fn size(&self) -> usize;
    fn forward(&mut self, re: &mut [f32], im: &mut [f32]);
    fn inverse(&mut self, re: &mut [f32], im: &mut [f32]);
    /// See `RealFft::steps`; 0 if the transform cannot run step by step.
    fn steps(&self) -> usize {
        0
    }
    fn step(&mut self, _re: &mut [f32], _im: &mut [f32], _step: usize) {}
}

pub struct ComplexAsReal<F: ComplexFft> {
    fft: F,
    re: Vec<f32>,
    im: Vec<f32>
}

impl<F: ComplexFft> ComplexAsReal<F> {
    /// The wrapped transform, for timing it without the adapter copies.
    pub fn fft(&self) -> &F {
        &self.fft
    }

    /// The full N-point complex buffers the kernels and steps work on.
    pub fn buffers(&self) -> (&[f32], &[f32]) {
        (&self.re, &self.im)
    }
}

impl<F: ComplexFft> RealFft for ComplexAsReal<F> {
    fn new(n: usize) -> Self {
        Self { fft: F::new(n), re: vec![0.0; n], im: vec![0.0; n] }
    }

    fn size(&self) -> usize {
        self.fft.size()
    }

    fn forward(&mut self, input: &[f32], re: &mut [f32], im: &mut [f32]) {
        let count = bins(self.fft.size());
        self.prepare_forward(input);
        self.forward_kernel(input, re, im);
        re[..count].copy_from_slice(&self.re[..count]);
        im[..count].copy_from_slice(&self.im[..count]);
    }

    fn inverse(&mut self, re: &[f32], im: &[f32], output: &mut [f32]) -> bool {
        self.prepare_inverse(re, im);
        self.inverse_kernel(re, im, output);
        output.copy_from_slice(&self.re);
        true
    }

    fn prepare_forward(&mut self, input: &[f32]) {
        self.re.copy_from_slice(input);
        self.im.fill(0.0);
    }

    fn forward_kernel(&mut self, _input: &[f32], _re: &mut [f32], _im: &mut [f32]) {
        self.fft.forward(&mut self.re, &mut self.im);
    }

    fn prepare_inverse(&mut self, re: &[f32], im: &[f32]) {
        let n = self.fft.size();
        let count = bins(n);
        self.re[..count].copy_from_slice(&re[..count]);
        self.im[..count].copy_from_slice(&im[..count]);
        // A real signal's spectrum is conjugate-symmetric: X[n − k] = conj(X[k]).
        for bin in 1..n / 2 {
            self.re[n - bin] = re[bin];
            self.im[n - bin] = -im[bin];
        }
    }

    fn inverse_kernel(&mut self, _re: &[f32], _im: &[f32], _output: &mut [f32]) -> bool {
        self.fft.inverse(&mut self.re, &mut self.im);
        true
    }

    fn steps(&self) -> usize {
        self.fft.steps()
    }

    fn run_step(&mut self, step: usize) {
        self.fft.step(&mut self.re, &mut self.im, step);
    }
}
