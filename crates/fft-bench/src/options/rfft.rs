//! `dsp::rfft::FftTables`, the second scalar baseline: real-input FFT (N/2 complex + post-twist) used by
//! the Convolver. Called directly; its API already matches `RealFft`, so nothing is adapted.

use crate::{bins, RealFft, MAX_SIZE};
use dsp::rfft::FftTables;

/// Table capacity for the largest measured size (`FftTables` needs `CAP >= n/2 + 1`).
const CAP: usize = bins(MAX_SIZE);

pub struct RfftOption {
    tables: Box<FftTables<CAP>>,
    scratch_re: Vec<f32>,
    scratch_im: Vec<f32>
}

impl RealFft for RfftOption {
    fn new(n: usize) -> Self {
        // SAFETY: `FftTables` holds only f32 arrays and a usize, for which all-zero bits are valid; it is
        // meant to be built in zeroed memory and filled by `init`. Heap, since it is ~128 KB.
        let mut tables: Box<FftTables<CAP>> = unsafe { Box::new_zeroed().assume_init() };
        tables.init(n);
        Self { tables, scratch_re: vec![0.0; n / 2], scratch_im: vec![0.0; n / 2] }
    }

    fn size(&self) -> usize {
        self.tables.size()
    }

    fn forward(&mut self, input: &[f32], re: &mut [f32], im: &mut [f32]) {
        self.tables.forward(input, re, im, &mut self.scratch_re, &mut self.scratch_im);
    }

    fn inverse(&mut self, re: &[f32], im: &[f32], output: &mut [f32]) -> bool {
        self.tables.inverse(re, im, output, &mut self.scratch_re, &mut self.scratch_im);
        true
    }
}
