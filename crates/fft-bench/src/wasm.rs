//! Import-free wasm exports for the Node runner (`run.mjs`) and, later, an AudioWorklet: the module needs
//! nothing from its host, so `WebAssembly.instantiate(bytes, {})` works anywhere. The host drives one
//! option at one size at a time and does all timing itself; these functions only do the work.
#![cfg(target_arch = "wasm32")]

use crate::options::ALL;
use crate::signals::Signal;
use crate::{bins, RealFft};
use std::cell::RefCell;

struct Bench {
    fft: Box<dyn RealFft>,
    input: Vec<f32>,
    re: Vec<f32>,
    im: Vec<f32>,
    output: Vec<f32>,
    has_inverse: bool
}

thread_local! {
    // wasm here is single-threaded; `thread_local` + `RefCell` gives safe global state without `static mut`.
    static BENCH: RefCell<Option<Bench>> = const { RefCell::new(None) };
}

fn with_bench(action: impl FnOnce(&mut Bench)) {
    BENCH.with(|bench| action(bench.borrow_mut().as_mut().expect("setup() must run first")));
}

#[no_mangle]
pub extern "C" fn option_count() -> u32 {
    ALL.len() as u32
}

/// Address of the option's name in linear memory; read `option_name_len` bytes of UTF-8 from it.
#[no_mangle]
pub extern "C" fn option_name_ptr(option: u32) -> *const u8 {
    ALL[option as usize].name.as_ptr()
}

#[no_mangle]
pub extern "C" fn option_name_len(option: u32) -> u32 {
    ALL[option as usize].name.len() as u32
}

/// 1 if the option is a full complex transform that can carry two real channels per call.
#[no_mangle]
pub extern "C" fn option_is_complex(option: u32) -> u32 {
    ALL[option as usize].complex as u32
}

/// Builds `option` at size `n` with white noise as input and a forward spectrum ready for the inverse.
/// Allocates; never call it inside a timed region.
#[no_mangle]
pub extern "C" fn setup(option: u32, n: u32) {
    let n = n as usize;
    let mut fft = (ALL[option as usize].create)(n);
    let input = Signal::WhiteNoise.generate(n);
    let (mut re, mut im, mut output) = (vec![0.0; bins(n)], vec![0.0; bins(n)], vec![0.0; n]);
    fft.forward(&input, &mut re, &mut im);
    let has_inverse = fft.inverse(&re, &im, &mut output);
    BENCH.with(|bench| *bench.borrow_mut() = Some(Bench { fft, input, re, im, output, has_inverse }));
}

#[no_mangle]
pub extern "C" fn has_inverse() -> u32 {
    let mut result = 0;
    with_bench(|bench| result = bench.has_inverse as u32);
    result
}

#[no_mangle]
pub extern "C" fn prepare_forward() {
    with_bench(|bench| bench.fft.prepare_forward(&bench.input));
}

#[no_mangle]
pub extern "C" fn forward_kernel() {
    with_bench(|bench| bench.fft.forward_kernel(&bench.input, &mut bench.re, &mut bench.im));
}

#[no_mangle]
pub extern "C" fn prepare_inverse() {
    with_bench(|bench| bench.fft.prepare_inverse(&bench.re, &bench.im));
}

#[no_mangle]
pub extern "C" fn inverse_kernel() {
    with_bench(|bench| {
        bench.fft.inverse_kernel(&bench.re, &bench.im, &mut bench.output);
    });
}

/// `count` × (prepare, then kernel if `with_kernel` is 1). The host times this with and without the
/// kernel; the difference divided by `count` is the kernel's cost without per-call timer overhead.
#[no_mangle]
pub extern "C" fn run_forward(count: u32, with_kernel: u32) {
    with_bench(|bench| {
        for _ in 0..count {
            bench.fft.prepare_forward(&bench.input);
            if with_kernel == 1 {
                bench.fft.forward_kernel(&bench.input, &mut bench.re, &mut bench.im);
            }
        }
    });
}

/// As `run_forward`, for the inverse.
#[no_mangle]
pub extern "C" fn run_inverse(count: u32, with_kernel: u32) {
    with_bench(|bench| {
        for _ in 0..count {
            bench.fft.prepare_inverse(&bench.re, &bench.im);
            if with_kernel == 1 {
                bench.fft.inverse_kernel(&bench.re, &bench.im, &mut bench.output);
            }
        }
    });
}

/// Forward steps of a stage-wise option (see `RealFft::steps`); 0 if it has none.
#[no_mangle]
pub extern "C" fn steps() -> u32 {
    let mut result = 0;
    with_bench(|bench| result = bench.fft.steps() as u32);
    result
}

#[no_mangle]
pub extern "C" fn run_step(step: u32) {
    with_bench(|bench| bench.fft.run_step(step as usize));
}
