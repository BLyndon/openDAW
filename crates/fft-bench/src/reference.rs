//! The absolute accuracy reference: an exact DFT of the same f32 input, computed in f64. O(n²), so it
//! belongs in tests and reports only.

use crate::bins;

/// Bins 0..=n/2 of a real spectrum in f64, split layout.
pub struct Spectrum {
    pub re: Vec<f64>,
    pub im: Vec<f64>
}

/// Forward DFT, unnormalized like the options: `X_k = Σ x_j · e^{−2πi·jk/n}`.
pub fn dft(input: &[f32]) -> Spectrum {
    let n = input.len();
    assert!(n.is_power_of_two(), "the index mask below needs a power of two");
    let angle_step = 2.0 * core::f64::consts::PI / n as f64;
    let cos: Vec<f64> = (0..n).map(|index| libm::cos(angle_step * index as f64)).collect();
    let sin: Vec<f64> = (0..n).map(|index| libm::sin(angle_step * index as f64)).collect();
    let mut spectrum = Spectrum { re: vec![0.0; bins(n)], im: vec![0.0; bins(n)] };
    for k in 0..bins(n) {
        let (mut sum_re, mut sum_im) = (0.0f64, 0.0f64);
        // (j·k) mod n, advanced by k per sample: an exact table index instead of an accumulating angle.
        let mut table_index = 0usize;
        for sample in input {
            sum_re += *sample as f64 * cos[table_index];
            sum_im -= *sample as f64 * sin[table_index];
            table_index = (table_index + k) & (n - 1);
        }
        spectrum.re[k] = sum_re;
        spectrum.im[k] = sum_im;
    }
    spectrum
}
