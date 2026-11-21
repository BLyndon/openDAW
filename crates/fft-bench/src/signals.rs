//! Test signals for accuracy tests, benches and the wasm runner. Generated once, never inside timed code.

/// The sine sits on bin `n / SINE_BIN_DIVISOR`: bin 32 at n = 1024, the analyser's own fixture.
pub const SINE_BIN_DIVISOR: usize = 32;
pub const SINE_AMPLITUDE: f32 = 0.5;
/// Same seed as `signalsmith-wasmbench`.
pub const NOISE_SEED: u32 = 0x1234_5678;
pub const NOISE_AMPLITUDE: f32 = 0.2;
/// Halfway between two bins: the worst case for leakage.
pub const OFF_BIN_OFFSET: f64 = 0.5;
pub const FULL_SCALE: f32 = 1.0;
/// Below the smallest normal f32 (≈ 1.18e-38), so every non-zero sample is subnormal.
pub const DENORMAL_AMPLITUDE: f32 = 1e-39;
/// 2^31: maps a `u32` onto [0, 2).
const HALF_U32_RANGE: f32 = 2_147_483_648.0;

/// The plan's test signals. Denormal input is reported, not gated: f32 has no precision left there.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Signal {
    Impulse,
    Dc,
    SineOnBin,
    SineOffBin,
    WhiteNoise,
    FullScaleNoise,
    FullScaleSine,
    Denormal
}

impl Signal {
    pub const ALL: [Signal; 8] = [Signal::Impulse, Signal::Dc, Signal::SineOnBin, Signal::SineOffBin,
        Signal::WhiteNoise, Signal::FullScaleNoise, Signal::FullScaleSine, Signal::Denormal];

    pub fn name(self) -> &'static str {
        match self {
            Signal::Impulse => "impulse",
            Signal::Dc => "dc",
            Signal::SineOnBin => "sine on bin",
            Signal::SineOffBin => "sine off bin",
            Signal::WhiteNoise => "white noise",
            Signal::FullScaleNoise => "full-scale noise",
            Signal::FullScaleSine => "full-scale sine",
            Signal::Denormal => "denormal noise"
        }
    }

    pub fn is_gated(self) -> bool {
        self != Signal::Denormal
    }

    pub fn generate(self, n: usize) -> Vec<f32> {
        let bin = (n / SINE_BIN_DIVISOR) as f64;
        match self {
            Signal::Impulse => impulse(n, 0),
            Signal::Dc => vec![1.0; n],
            Signal::SineOnBin => sine_on_bin(n),
            Signal::SineOffBin => sine(n, bin + OFF_BIN_OFFSET, SINE_AMPLITUDE),
            Signal::WhiteNoise => white_noise(n, NOISE_AMPLITUDE),
            Signal::FullScaleNoise => white_noise(n, FULL_SCALE),
            Signal::FullScaleSine => sine(n, bin, FULL_SCALE),
            Signal::Denormal => white_noise(n, DENORMAL_AMPLITUDE)
        }
    }
}

/// Marsaglia's xorshift32 (shifts 13, 17, 5): advances `state` and returns it.
pub fn xorshift32(state: &mut u32) -> u32 {
    *state ^= *state << 13;
    *state ^= *state >> 17;
    *state ^= *state << 5;
    *state
}

/// A sine completing `bin` cycles over `n` samples (it lands on bin `bin` if that is whole).
pub fn sine(n: usize, bin: f64, amplitude: f32) -> Vec<f32> {
    (0..n).map(|index| libm::sin(index as f64 * bin / n as f64 * 2.0 * core::f64::consts::PI) as f32 * amplitude).collect()
}

pub fn sine_on_bin(n: usize) -> Vec<f32> {
    sine(n, (n / SINE_BIN_DIVISOR) as f64, SINE_AMPLITUDE)
}

/// Uniform noise in [-amplitude, amplitude), deterministic from `NOISE_SEED`.
pub fn white_noise(n: usize, amplitude: f32) -> Vec<f32> {
    let mut state = NOISE_SEED;
    (0..n).map(|_| (xorshift32(&mut state) as f32 / HALF_U32_RANGE - 1.0) * amplitude).collect()
}

pub fn impulse(n: usize, position: usize) -> Vec<f32> {
    let mut signal = vec![0.0; n];
    signal[position] = 1.0;
    signal
}
