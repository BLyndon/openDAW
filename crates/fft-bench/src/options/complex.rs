//! Adapter for full N-point complex FFTs fed with real input, the way `SignalsmithStretch` uses them:
//! `im = 0` before `forward`, a Hermitian mirror before `inverse`.

use crate::{bins, RealFft};

/// An in-place complex FFT on split arrays; `inverse` scales by 1/n.
pub trait ComplexFft {
    fn new(n: usize) -> Self;
    fn size(&self) -> usize;
    fn forward(&self, re: &mut [f32], im: &mut [f32]);
    fn inverse(&self, re: &mut [f32], im: &mut [f32]);
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
        self.re.copy_from_slice(input);
        self.im.fill(0.0);
        self.fft.forward(&mut self.re, &mut self.im);
        re[..count].copy_from_slice(&self.re[..count]);
        im[..count].copy_from_slice(&self.im[..count]);
    }

    fn inverse(&mut self, re: &[f32], im: &[f32], output: &mut [f32]) -> bool {
        let n = self.fft.size();
        let count = bins(n);
        self.re[..count].copy_from_slice(&re[..count]);
        self.im[..count].copy_from_slice(&im[..count]);
        // A real signal's spectrum is conjugate-symmetric: X[n − k] = conj(X[k]).
        for bin in 1..n / 2 {
            self.re[n - bin] = re[bin];
            self.im[n - bin] = -im[bin];
        }
        self.fft.inverse(&mut self.re, &mut self.im);
        output.copy_from_slice(&self.re);
        true
    }
}
