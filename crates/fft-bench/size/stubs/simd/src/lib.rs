//! The prototype SIMD128 kernel (`src/options/simd`), forward and inverse at a runtime size. The kernel files are
//! compiled in directly, so the stub measures the kernel without the harness around it.
#![no_std]
extern crate alloc;
extern crate support;

#[path = "../../../../src/options/simd/v4.rs"]
mod v4;
#[path = "../../../../src/options/simd/kernel.rs"]
mod kernel;

use alloc::vec;

#[no_mangle]
pub extern "C" fn run(n: usize) -> f32 {
    let mut fft = kernel::RealFft::new(n);
    let input = vec![0.5f32; n];
    let (mut re, mut im, mut output) = (vec![0.0f32; n / 2 + 1], vec![0.0f32; n / 2 + 1], vec![0.0f32; n]);
    fft.forward(&input, &mut re, &mut im);
    fft.inverse(&re, &im, &mut output);
    output[1]
}
