//! `dsp::rfft::FftTables`, forward and inverse at a runtime size, as the Convolver uses it.
#![no_std]
extern crate alloc;
extern crate support;

use alloc::boxed::Box;
use alloc::vec;
use dsp::rfft::FftTables;

/// Capacity for N = 16384, the Convolver's largest size.
const CAP: usize = 8193;

#[no_mangle]
pub extern "C" fn run(n: usize) -> f32 {
    // SAFETY: only f32 arrays and a usize; built in zeroed memory and filled by `init`, as in dsp.
    let mut tables: Box<FftTables<CAP>> = unsafe { Box::new_zeroed().assume_init() };
    tables.init(n);
    let input = vec![0.5f32; n];
    let (mut re, mut im, mut output) = (vec![0.0f32; n / 2 + 1], vec![0.0f32; n / 2 + 1], vec![0.0f32; n]);
    let (mut scratch_re, mut scratch_im) = (vec![0.0f32; n / 2], vec![0.0f32; n / 2]);
    tables.forward(&input, &mut re, &mut im, &mut scratch_re, &mut scratch_im);
    tables.inverse(&re, &im, &mut output, &mut scratch_re, &mut scratch_im);
    output[1]
}
