//! `realfft`, forward and inverse at a runtime size, in a `no_std` module with the engine's kind of
//! runtime. Expected not to link: realfft needs `std`, whose panic handler collides with the engine's.
#![no_std]
extern crate alloc;
extern crate support;

use alloc::vec;
use realfft::num_complex::Complex;
use realfft::RealFftPlanner;

#[no_mangle]
pub extern "C" fn run(n: usize) -> f32 {
    let mut planner = RealFftPlanner::<f32>::new();
    let (forward, inverse) = (planner.plan_fft_forward(n), planner.plan_fft_inverse(n));
    let (mut input, mut spectrum) = (vec![0.5f32; n], vec![Complex::new(0.0f32, 0.0); n / 2 + 1]);
    let _ = forward.process(&mut input, &mut spectrum);
    let _ = inverse.process(&mut spectrum, &mut input);
    input[1]
}
