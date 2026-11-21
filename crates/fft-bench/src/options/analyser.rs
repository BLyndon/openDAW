//! Copy of `AudioAnalyser` (`dsp::analyser`) for every harness size, the first scalar baseline: a full
//! N-point complex radix-2 FFT on real input. The size is a compile-time constant and the buffers are fixed
//! arrays, as in the original (`FFT_SIZE` = 1024), so the compiler sees the same code shape: identical
//! rounding and the same speed (`benches/fft.rs`, group `analyser_fidelity`). A copy with slices and a
//! runtime size was bit-identical but its FFT about 15 % slower.

use crate::contract::analyser_window;
use crate::{bins, RealFft};

/// TS AudioAnalyser.DEFAULT_DECAY, as in the original.
const DECAY_FACTOR: f32 = 0.90;

/// Reverses all 32 bits: swaps neighbouring bits, then pairs, then nibbles, then the four bytes.
fn reverse(mut i: u32) -> u32 {
    i = (i & 0x55555555) << 1 | (i >> 1) & 0x55555555;
    i = (i & 0x33333333) << 2 | (i >> 2) & 0x33333333;
    i = (i & 0x0f0f0f0f) << 4 | (i >> 4) & 0x0f0f0f0f;
    (i << 24) | ((i & 0xff00) << 8) | ((i >> 8) & 0xff00) | (i >> 24)
}

/// The analyser at size `N`. `HALF` is `N / 2`: stable Rust cannot write `N / 2` as an array length.
pub struct AnalyserFixed<const N: usize, const HALF: usize> {
    cos_table: [f32; HALF],
    sin_table: [f32; HALF],
    window: [f32; N],
    real: [f32; N],
    imag: [f32; N],
    bins: [f32; HALF],
    index: usize,
    decay: bool
}

impl<const N: usize, const HALF: usize> AnalyserFixed<N, HALF> {
    /// `32 - log2(N)`: shifts a reversed 32-bit index down to a log2(N)-bit index.
    const LEVELS: u32 = 32 - N.trailing_zeros();

    /// Built in zeroed heap memory and filled in place, as the engine builds the original; up to 256 KB.
    pub fn boxed() -> Box<Self> {
        assert!(N.is_power_of_two() && HALF == N / 2);
        // SAFETY: the struct holds only f32 arrays, a usize and a bool; all-zero bits are valid for each.
        let mut analyser: Box<Self> = unsafe { Box::new_zeroed().assume_init() };
        for index in 0..HALF {
            let angle = 2.0 * core::f64::consts::PI * index as f64 / N as f64;
            analyser.cos_table[index] = libm::cos(angle) as f32;
            analyser.sin_table[index] = libm::sin(angle) as f32;
        }
        analyser.window.copy_from_slice(&analyser_window(N));
        analyser
    }

    fn update(&mut self) {
        for index in 0..N {
            self.real[index] *= self.window[index];
        }
        self.fft();
        let scale = 1.0 / HALF as f32;
        for index in 0..HALF {
            let re = self.real[index];
            let im = self.imag[index];
            let energy = math::sqrt((re * re + im * im) as f64) as f32 * scale;
            if self.bins[index] < energy {
                self.bins[index] = energy;
            } else if self.decay {
                self.bins[index] *= DECAY_FACTOR;
            }
        }
        self.index = 0;
        self.imag.fill(0.0);
        self.decay = false;
    }

    fn fft(&mut self) {
        for i in 0..N {
            let j = (reverse(i as u32) >> Self::LEVELS) as usize;
            if j > i {
                self.real.swap(i, j);
                self.imag.swap(i, j);
            }
        }
        let mut size = 2usize;
        loop {
            let half_size = size >> 1;
            let table_step = N / size;
            let mut i = 0usize;
            while i < N {
                let m = i + half_size;
                let mut k = 0usize;
                for j in i..m {
                    let index = j + half_size;
                    let cos = self.cos_table[k];
                    let sin = self.sin_table[k];
                    let real_i = self.real[index];
                    let imag_i = self.imag[index];
                    let p_re = real_i * cos + imag_i * sin;
                    let p_im = imag_i * cos - real_i * sin;
                    let real_j = self.real[j];
                    let imag_j = self.imag[j];
                    self.real[index] = real_j - p_re;
                    self.imag[index] = imag_j - p_im;
                    self.real[j] = real_j + p_re;
                    self.imag[j] = imag_j + p_im;
                    k += table_step;
                }
                i += size;
            }
            if size == N {
                break;
            }
            size <<= 1;
        }
    }
}

/// The size-independent face of `AnalyserFixed`, so one option can hold any size.
pub trait AnalyserKernel {
    fn size(&self) -> usize;
    /// What the analyser has in its buffers before the FFT: samples in `real`, `imag` cleared.
    fn load(&mut self, input: &[f32]);
    fn fft(&mut self);
    /// `real` and `imag` after `fft`.
    fn spectrum(&self) -> (&[f32], &[f32]);
    /// `AudioAnalyser::process`: sum L+R into the frame; a full frame runs window, FFT and magnitudes.
    fn process(&mut self, left: &[f32], right: &[f32]);
    fn bins(&self) -> &[f32];
}

impl<const N: usize, const HALF: usize> AnalyserKernel for AnalyserFixed<N, HALF> {
    fn size(&self) -> usize {
        N
    }

    fn load(&mut self, input: &[f32]) {
        self.real.copy_from_slice(input);
        self.imag.fill(0.0);
    }

    fn fft(&mut self) {
        AnalyserFixed::fft(self)
    }

    fn spectrum(&self) -> (&[f32], &[f32]) {
        (&self.real, &self.imag)
    }

    fn process(&mut self, left: &[f32], right: &[f32]) {
        for index in 0..left.len().min(right.len()) {
            self.real[self.index] = left[index] + right[index];
            self.index += 1;
            if self.index == N {
                self.update();
            }
        }
    }

    fn bins(&self) -> &[f32] {
        &self.bins
    }
}

/// One compiled instance per harness size.
pub fn analyser_for(n: usize) -> Box<dyn AnalyserKernel> {
    match n {
        256 => AnalyserFixed::<256, 128>::boxed(),
        512 => AnalyserFixed::<512, 256>::boxed(),
        1024 => AnalyserFixed::<1024, 512>::boxed(),
        2048 => AnalyserFixed::<2048, 1024>::boxed(),
        4096 => AnalyserFixed::<4096, 2048>::boxed(),
        8192 => AnalyserFixed::<8192, 4096>::boxed(),
        16384 => AnalyserFixed::<16384, 8192>::boxed(),
        _ => panic!("no analyser instance for n = {n}; add one to `analyser_for`")
    }
}

pub struct AnalyserFft {
    kernel: Box<dyn AnalyserKernel>
}

impl RealFft for AnalyserFft {
    fn new(n: usize) -> Self {
        Self { kernel: analyser_for(n) }
    }

    fn size(&self) -> usize {
        self.kernel.size()
    }

    fn forward(&mut self, input: &[f32], re: &mut [f32], im: &mut [f32]) {
        let count = bins(self.kernel.size());
        self.prepare_forward(input);
        self.forward_kernel(input, re, im);
        let (real, imag) = self.kernel.spectrum();
        re[..count].copy_from_slice(&real[..count]);
        im[..count].copy_from_slice(&imag[..count]);
    }

    fn inverse(&mut self, _re: &[f32], _im: &[f32], _output: &mut [f32]) -> bool {
        false
    }

    fn prepare_forward(&mut self, input: &[f32]) {
        self.kernel.load(input);
    }

    fn forward_kernel(&mut self, _input: &[f32], _re: &mut [f32], _im: &mut [f32]) {
        self.kernel.fft();
    }
}
