//! Size-generic copy of `AudioAnalyser::fft` (`dsp::analyser`), the first scalar baseline: a full N-point
//! complex radix-2 FFT on real input. Tables and butterflies are operation-for-operation identical to the
//! original, so rounding and timing stand for the analyser; only the fixed size 1024 became `n`.

use crate::{bins, RealFft};

/// Reverses all 32 bits: swaps neighbouring bits, then pairs, then nibbles, then the four bytes.
fn reverse(mut i: u32) -> u32 {
    i = (i & 0x55555555) << 1 | (i >> 1) & 0x55555555;
    i = (i & 0x33333333) << 2 | (i >> 2) & 0x33333333;
    i = (i & 0x0f0f0f0f) << 4 | (i >> 4) & 0x0f0f0f0f;
    (i << 24) | ((i & 0xff00) << 8) | ((i >> 8) & 0xff00) | (i >> 24)
}

/// The twiddle tables and the in-place transform, separate from the buffers so benches can time `process` alone.
pub struct AnalyserPlan {
    n: usize,
    /// `32 - log2(n)`: shifts a reversed 32-bit index down to a log2(n)-bit index.
    levels: u32,
    cos_table: Vec<f32>,
    sin_table: Vec<f32>
}

impl AnalyserPlan {
    pub fn new(n: usize) -> Self {
        assert!(n.is_power_of_two() && n >= 2);
        let half = n >> 1;
        let mut cos_table = vec![0.0; half];
        let mut sin_table = vec![0.0; half];
        for index in 0..half {
            let angle = 2.0 * core::f64::consts::PI * index as f64 / n as f64;
            cos_table[index] = libm::cos(angle) as f32;
            sin_table[index] = libm::sin(angle) as f32;
        }
        Self { n, levels: 32 - n.trailing_zeros(), cos_table, sin_table }
    }

    pub fn size(&self) -> usize {
        self.n
    }

    /// In-place forward complex FFT on `real`/`imag` (`n` values each), unnormalized.
    pub fn process(&self, real: &mut [f32], imag: &mut [f32]) {
        let n = self.n;
        for i in 0..n {
            let j = (reverse(i as u32) >> self.levels) as usize;
            if j > i {
                real.swap(i, j);
                imag.swap(i, j);
            }
        }
        let mut size = 2usize;
        loop {
            let half_size = size >> 1;
            let table_step = n / size;
            let mut i = 0usize;
            while i < n {
                let m = i + half_size;
                let mut k = 0usize;
                for j in i..m {
                    let index = j + half_size;
                    let cos = self.cos_table[k];
                    let sin = self.sin_table[k];
                    let real_i = real[index];
                    let imag_i = imag[index];
                    let p_re = real_i * cos + imag_i * sin;
                    let p_im = imag_i * cos - real_i * sin;
                    let real_j = real[j];
                    let imag_j = imag[j];
                    real[index] = real_j - p_re;
                    imag[index] = imag_j - p_im;
                    real[j] = real_j + p_re;
                    imag[j] = imag_j + p_im;
                    k += table_step;
                }
                i += size;
            }
            if size == n {
                break;
            }
            size <<= 1;
        }
    }
}

pub struct AnalyserFft {
    plan: AnalyserPlan,
    real: Vec<f32>,
    imag: Vec<f32>
}

impl AnalyserFft {
    pub fn plan(&self) -> &AnalyserPlan {
        &self.plan
    }
}

impl RealFft for AnalyserFft {
    fn new(n: usize) -> Self {
        Self { plan: AnalyserPlan::new(n), real: vec![0.0; n], imag: vec![0.0; n] }
    }

    fn size(&self) -> usize {
        self.plan.n
    }

    fn forward(&mut self, input: &[f32], re: &mut [f32], im: &mut [f32]) {
        let count = bins(self.plan.n);
        self.real.copy_from_slice(input);
        self.imag.fill(0.0);
        self.plan.process(&mut self.real, &mut self.imag);
        re[..count].copy_from_slice(&self.real[..count]);
        im[..count].copy_from_slice(&self.imag[..count]);
    }

    fn inverse(&mut self, _re: &[f32], _im: &[f32], _output: &mut [f32]) -> bool {
        false
    }
}
