//! Benchmark and accuracy harness for real-input FFTs: the current scalar FFTs (`dsp::analyser`,
//! `dsp::rfft`) and candidate replacements behind one interface. Standalone, not part of the engine build.

// The verbatim copy in `options::reverted` imports `alloc::vec::Vec`, as in its no_std origin.
extern crate alloc;

pub mod contract;
pub mod env;
pub mod metrics;
pub mod options;
pub mod reference;
pub mod signals;

pub const SIZES: [usize; 7] = [256, 512, 1024, 2048, 4096, 8192, 16384];
pub const MAX_SIZE: usize = SIZES[SIZES.len() - 1];

/// Bins of a real FFT of size `n`, DC to Nyquist inclusive.
pub const fn bins(n: usize) -> usize {
    n / 2 + 1
}

/// A real-input FFT of one fixed power-of-two size. Only `new` may allocate.
///
/// Benchmarks time only the `*_kernel` methods: the option's native call, without adapter copies. The
/// `prepare_*` methods load the data the way the option's consumer would and are not timed. Options
/// whose native call is `forward`/`inverse` itself keep the defaults.
pub trait RealFft {
    fn new(n: usize) -> Self where Self: Sized;
    fn size(&self) -> usize;
    /// `size()` samples in, `bins(size())` unnormalized bins out in split layout.
    fn forward(&mut self, input: &[f32], re: &mut [f32], im: &mut [f32]);
    /// Inverse of `forward` (round trip is identity); returns `false` if the option has none.
    fn inverse(&mut self, re: &[f32], im: &[f32], output: &mut [f32]) -> bool;
    fn prepare_forward(&mut self, _input: &[f32]) {}
    fn forward_kernel(&mut self, input: &[f32], re: &mut [f32], im: &mut [f32]) {
        self.forward(input, re, im)
    }
    fn prepare_inverse(&mut self, _re: &[f32], _im: &[f32]) {}
    fn inverse_kernel(&mut self, re: &[f32], im: &[f32], output: &mut [f32]) -> bool {
        self.inverse(re, im, output)
    }
}
