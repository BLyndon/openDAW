//! The analyser's output contract for any FFT option: the steps `AudioAnalyser::update` runs around its
//! FFT (Blackman window, magnitude in f64, scale 1/(n/2)), so options can be compared on the analyser's bins.

use crate::{bins, RealFft};

// TS calls it Blackman, but these are the 3-term Blackman-Harris coefficients (not 0.42 / 0.5 / 0.08).
const WINDOW_A0: f64 = 0.42323;
const WINDOW_A1: f64 = 0.49755;
const WINDOW_A2: f64 = 0.07922;

/// TS `Window.create(Blackman, n)` as built in `AudioAnalyser::init`: `a0 − a1·cos(2πi/(n−1)) + a2·cos(4πi/(n−1))`.
pub fn analyser_window(n: usize) -> Vec<f32> {
    let a = core::f64::consts::PI / (n - 1) as f64;
    (0..n).map(|index| {
        let phase = index as f64;
        (WINDOW_A0 - WINDOW_A1 * libm::cos(2.0 * a * phase) + WINDOW_A2 * libm::cos(4.0 * a * phase)) as f32
    }).collect()
}

/// The `n/2` magnitude bins `AudioAnalyser` would hold after its first frame of `signal`. Allocates.
pub fn analyser_bins(fft: &mut dyn RealFft, signal: &[f32], window: &[f32]) -> Vec<f32> {
    let n = fft.size();
    let windowed: Vec<f32> = signal.iter().zip(window).map(|(sample, weight)| sample * weight).collect();
    let mut re = vec![0.0; bins(n)];
    let mut im = vec![0.0; bins(n)];
    fft.forward(&windowed, &mut re, &mut im);
    let scale = 1.0 / (n / 2) as f32;
    (0..n / 2).map(|index| math::sqrt((re[index] * re[index] + im[index] * im[index]) as f64) as f32 * scale).collect()
}
