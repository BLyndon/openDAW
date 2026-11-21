//! `signalsmith::fft::Fft`, forward and inverse at a runtime size, plus the stage-wise steps the
//! time-stretch uses.
#![no_std]
extern crate alloc;
extern crate support;

use alloc::vec;
use signalsmith::fft::Fft;

#[no_mangle]
pub extern "C" fn run(n: usize) -> f32 {
    let fft = Fft::new(n);
    let (mut re, mut im) = (vec![0.5f32; n], vec![0.0f32; n]);
    fft.forward(&mut re, &mut im);
    fft.bit_reverse(&mut re, &mut im);
    for level in 0..fft.stages() {
        fft.stage(&mut re, &mut im, level, true);
    }
    fft.scale(&mut re, &mut im);
    fft.inverse(&mut re, &mut im);
    re[1]
}
