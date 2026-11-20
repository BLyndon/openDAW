//! Benchmark and accuracy harness for real-input FFTs: the current scalar FFTs (`dsp::analyser`,
//! `dsp::rfft`) and candidate replacements behind one interface. Standalone, not part of the engine build.

pub const SIZES: [usize; 7] = [256, 512, 1024, 2048, 4096, 8192, 16384];

/// Bins of a real FFT of size `n`, DC to Nyquist inclusive.
pub const fn bins(n: usize) -> usize {
    n / 2 + 1
}

/// A real-input FFT of one fixed power-of-two size. Only `new` may allocate.
pub trait RealFft {
    fn new(n: usize) -> Self where Self: Sized;
    fn size(&self) -> usize;
    /// `size()` samples in, `bins(size())` unnormalized bins out in split layout.
    fn forward(&mut self, input: &[f32], re: &mut [f32], im: &mut [f32]);
    /// Inverse of `forward` (round trip is identity); returns `false` if the option has none.
    fn inverse(&mut self, re: &[f32], im: &[f32], output: &mut [f32]) -> bool;
}
