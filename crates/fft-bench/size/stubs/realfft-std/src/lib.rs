//! `realfft`, forward and inverse at a runtime size, in a plain `std` module: its size where it can link.
//! The planner is the library's API, so its algorithm selection is part of the cost.

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
