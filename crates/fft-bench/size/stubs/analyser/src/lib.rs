//! `dsp::analyser::AudioAnalyser`, as a device uses it: built in zeroed memory, fed blocks, bins read.
#![no_std]
extern crate alloc;
extern crate support;

use alloc::boxed::Box;
use alloc::vec;
use dsp::analyser::AudioAnalyser;

#[no_mangle]
pub extern "C" fn run(n: usize) -> f32 {
    // SAFETY: only f32 arrays, usizes and a bool; the engine builds it the same way, then calls `init`.
    let mut analyser: Box<AudioAnalyser> = unsafe { Box::new_zeroed().assume_init() };
    analyser.init(0.0);
    let block = vec![0.5f32; n];
    analyser.process(&block, &block);
    analyser.bins()[1]
}
