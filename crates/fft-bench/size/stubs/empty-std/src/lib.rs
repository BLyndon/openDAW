//! Size baseline for the `std` stub: a plain `std` module and nothing else.

#[no_mangle]
pub extern "C" fn run(n: usize) -> f32 {
    n as f32
}
