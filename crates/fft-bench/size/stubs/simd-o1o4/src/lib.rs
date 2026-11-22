//! The `simd-o1o4` option: the `simd` kernel with the outlook items O1 and O4 (`src/options/outlook/kernel.rs`),
//! forward and inverse at a runtime size. The kernel files are compiled in directly and re-exported under the module
//! paths they use in the harness (`crate::options::…`), so the stub measures the kernel without the harness around it.
#![no_std]
extern crate alloc;
extern crate support;

#[path = "../../../../src/options/simd/v4.rs"]
pub mod v4;
#[path = "../../../../src/options/simd/kernel.rs"]
pub mod simd_kernel;
#[path = "../../../../src/options/outlook/kernel.rs"]
pub mod outlook_kernel;

// The module paths the kernel files use in the harness.
mod options {
    pub mod simd {
        pub use crate::simd_kernel as kernel;
        pub use crate::v4;
    }
    pub mod outlook {
        pub use crate::outlook_kernel as kernel;
    }
}

use alloc::vec;
use options::outlook::kernel::{RealFft, FUSED_TWIST, LOAD_SPLAT};

#[no_mangle]
pub extern "C" fn run(n: usize) -> f32 {
    let mut fft = RealFft::<{ FUSED_TWIST | LOAD_SPLAT }>::new(n);
    let input = vec![0.5f32; n];
    let (mut re, mut im, mut output) = (vec![0.0f32; n / 2 + 1], vec![0.0f32; n / 2 + 1], vec![0.0f32; n]);
    fft.forward(&input, &mut re, &mut im);
    fft.inverse(&re, &im, &mut output);
    output[1]
}
