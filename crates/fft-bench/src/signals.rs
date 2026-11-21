//! Test signals for accuracy tests, benches and the wasm runner. Generated once, never inside timed code.

/// The sine sits on bin `n / SINE_BIN_DIVISOR`: bin 32 at n = 1024, the analyser's own fixture.
pub const SINE_BIN_DIVISOR: usize = 32;
pub const SINE_AMPLITUDE: f32 = 0.5;
/// Same seed as `signalsmith-wasmbench`.
pub const NOISE_SEED: u32 = 0x1234_5678;
pub const NOISE_AMPLITUDE: f32 = 0.2;
/// 2^31: maps a `u32` onto [0, 2).
const HALF_U32_RANGE: f32 = 2_147_483_648.0;

/// Marsaglia's xorshift32 (shifts 13, 17, 5): advances `state` and returns it.
pub fn xorshift32(state: &mut u32) -> u32 {
    *state ^= *state << 13;
    *state ^= *state >> 17;
    *state ^= *state << 5;
    *state
}

pub fn sine_on_bin(n: usize) -> Vec<f32> {
    let bin = (n / SINE_BIN_DIVISOR) as f64;
    (0..n).map(|index| libm::sin(index as f64 * bin / n as f64 * 2.0 * core::f64::consts::PI) as f32 * SINE_AMPLITUDE).collect()
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
