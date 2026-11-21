//! Size baseline for the `no_std` stubs: the engine-like runtime (`support`) and nothing else.
#![no_std]
extern crate support;

#[no_mangle]
pub extern "C" fn run(n: usize) -> f32 {
    n as f32
}
