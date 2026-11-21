//! Accuracy metrics from the plan, all computed in f64.

use crate::reference::Spectrum;

/// Plan target: forward → inverse on white noise.
pub const ROUND_TRIP_LIMIT: f64 = 1e-5;
/// Plan proposal for the analyser output contract, ≈ −100 dB relative to the spectrum peak.
pub const CONTRACT_EPSILON: f64 = 1e-5;
/// Plan: a candidate's relative RMS may be at most this multiple of the baseline's.
pub const RMS_GATE_FACTOR: f64 = 2.0;
/// Below one f32 epsilon a result is as exact as f32 gets. Without this floor an exact baseline (impulse
/// 0, DC ≈ 1e-15) would demand a bit-exact candidate. A harness decision, not from the plan.
pub const RMS_GATE_FLOOR: f64 = f32::EPSILON as f64;

/// The largest relative RMS a candidate may show where the baseline shows `baseline_rms`.
pub fn rms_gate(baseline_rms: f64) -> f64 {
    RMS_GATE_FACTOR * baseline_rms.max(RMS_GATE_FLOOR)
}

/// `sqrt(Σ|X − X_ref|² / Σ|X_ref|²)` over bins 0..=n/2.
pub fn relative_rms(re: &[f32], im: &[f32], reference: &Spectrum) -> f64 {
    let (mut error, mut energy) = (0.0f64, 0.0f64);
    for bin in 0..reference.re.len() {
        let (delta_re, delta_im) = (re[bin] as f64 - reference.re[bin], im[bin] as f64 - reference.im[bin]);
        error += delta_re * delta_re + delta_im * delta_im;
        energy += reference.re[bin] * reference.re[bin] + reference.im[bin] * reference.im[bin];
    }
    (error / energy).sqrt()
}

/// `max |x − x'|` between the input and its forward → inverse round trip.
pub fn max_abs_error(input: &[f32], output: &[f32]) -> f64 {
    input.iter().zip(output).map(|(original, restored)| (*original as f64 - *restored as f64).abs()).fold(0.0, f64::max)
}

/// Relative gap between `Σx²` and `Σ|X|² / n`; scaling errors show up here.
pub fn parseval_error(input: &[f32], re: &[f32], im: &[f32]) -> f64 {
    let n = input.len();
    let time: f64 = input.iter().map(|sample| *sample as f64 * *sample as f64).sum();
    let power = |bin: usize| re[bin] as f64 * re[bin] as f64 + im[bin] as f64 * im[bin] as f64;
    // One-sided spectrum: DC and Nyquist appear once, every other bin stands for itself and its mirror.
    let mirrored: f64 = (1..n / 2).map(|bin| 2.0 * power(bin)).sum();
    let frequency = (power(0) + power(n / 2) + mirrored) / n as f64;
    (time - frequency).abs() / time
}

/// `max |B_new − B_old| / max |B_old|` on two sets of analyser bins. An all-zero `old_bins` (denormal
/// input, whose squared magnitudes underflow) has no peak; the absolute deviation is returned then.
pub fn contract_deviation(new_bins: &[f32], old_bins: &[f32]) -> f64 {
    let deviation = new_bins.iter().zip(old_bins).map(|(new, old)| (*new as f64 - *old as f64).abs()).fold(0.0, f64::max);
    let peak = old_bins.iter().map(|old| (*old as f64).abs()).fold(0.0, f64::max);
    if peak == 0.0 { deviation } else { deviation / peak }
}
