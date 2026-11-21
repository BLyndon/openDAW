// Accuracy suite. First the tools themselves (reference DFT, metrics) are checked against known answers,
// then both scalar baselines are held to the plan's targets. Measured on 2026-11-21: both baselines stay
// at or below 1.6e-7 relative RMS, 1.5e-7 Parseval error, 1.4e-7 round trip and 1.9e-7 contract deviation.

use fft_bench::contract::{analyser_bins, analyser_window};
use fft_bench::metrics::{contract_deviation, max_abs_error, parseval_error, relative_rms, CONTRACT_EPSILON, ROUND_TRIP_LIMIT};
use fft_bench::options::{analyser::AnalyserFft, rfft::RfftOption};
use fft_bench::reference::dft;
use fft_bench::signals::{impulse, sine_on_bin, Signal, SINE_AMPLITUDE, SINE_BIN_DIVISOR};
use fft_bench::{bins, RealFft, SIZES};

// A sanity bound for the baselines, not a plan target: ≈ 8 f32 epsilons, 6× above the worst measured
// value. A broken table or butterfly lands orders of magnitude above it.
const BASELINE_RMS_LIMIT: f64 = 1e-6;
const BASELINE_PARSEVAL_LIMIT: f64 = 1e-6;
// The f64 reference itself is exact to about 1e-16 · n; 1e-9 is far above that and far below f32.
const REFERENCE_TOLERANCE: f64 = 1e-9;
const ANALYSER_SIZE: usize = 1024;

fn baselines(n: usize) -> Vec<(&'static str, Box<dyn RealFft>)> {
    vec![("analyser", Box::new(AnalyserFft::new(n))), ("rfft", Box::new(RfftOption::new(n)))]
}

fn forward(fft: &mut dyn RealFft, input: &[f32]) -> (Vec<f32>, Vec<f32>) {
    let n = fft.size();
    let (mut re, mut im) = (vec![0.0; bins(n)], vec![0.0; bins(n)]);
    fft.forward(input, &mut re, &mut im);
    (re, im)
}

#[test]
fn reference_dft_of_an_impulse_is_flat() {
    let spectrum = dft(&impulse(256, 0));
    assert!(spectrum.re.iter().all(|value| (value - 1.0).abs() < REFERENCE_TOLERANCE));
    assert!(spectrum.im.iter().all(|value| value.abs() < REFERENCE_TOLERANCE));
}

#[test]
fn reference_dft_of_dc_is_n_at_bin_zero_only() {
    let n = 256;
    let spectrum = dft(&vec![1.0; n]);
    assert!((spectrum.re[0] - n as f64).abs() < REFERENCE_TOLERANCE);
    assert!((1..bins(n)).all(|bin| spectrum.re[bin].abs() < REFERENCE_TOLERANCE && spectrum.im[bin].abs() < REFERENCE_TOLERANCE));
}

#[test]
fn reference_dft_puts_a_sine_on_its_bin() {
    // A real sine of amplitude A on bin k has |X_k| = A·n/2 (the other half sits on the mirror bin n − k).
    let n = 1024;
    let spectrum = dft(&sine_on_bin(n));
    let bin = n / SINE_BIN_DIVISOR;
    let magnitude = (spectrum.re[bin] * spectrum.re[bin] + spectrum.im[bin] * spectrum.im[bin]).sqrt();
    let expected = SINE_AMPLITUDE as f64 * n as f64 / 2.0;
    // The input is the f32-rounded sine, so the match is only as good as f32.
    assert!((magnitude - expected).abs() / expected < 1e-6, "{magnitude} vs {expected}");
}

#[test]
fn metrics_detect_what_they_should() {
    let n = 256;
    let input = Signal::WhiteNoise.generate(n);
    let spectrum = dft(&input);
    let re: Vec<f32> = spectrum.re.iter().map(|value| *value as f32).collect();
    let im: Vec<f32> = spectrum.im.iter().map(|value| *value as f32).collect();
    assert!(relative_rms(&re, &im, &spectrum) < 1e-7, "rounding the reference to f32 is near-exact");
    assert!(parseval_error(&input, &re, &im) < 1e-6, "the reference satisfies Parseval");
    let doubled_re: Vec<f32> = re.iter().map(|value| value * 2.0).collect();
    let doubled_im: Vec<f32> = im.iter().map(|value| value * 2.0).collect();
    assert!((relative_rms(&doubled_re, &doubled_im, &spectrum) - 1.0).abs() < 1e-6, "a doubled spectrum is 100% off");
    assert!((parseval_error(&input, &doubled_re, &doubled_im) - 3.0).abs() < 1e-5, "a doubled spectrum has 4× the energy");
    assert_eq!(contract_deviation(&re, &re), 0.0);
    assert_eq!(contract_deviation(&[0.0; 4], &[0.0; 4]), 0.0, "all-zero bins give 0, not NaN");
}

#[test]
fn baselines_match_the_f64_reference_and_parseval() {
    for n in SIZES {
        for signal in Signal::ALL.into_iter().filter(|signal| signal.is_gated()) {
            let input = signal.generate(n);
            let reference = dft(&input);
            for (name, mut fft) in baselines(n) {
                let (re, im) = forward(fft.as_mut(), &input);
                let rms = relative_rms(&re, &im, &reference);
                let parseval = parseval_error(&input, &re, &im);
                assert!(rms < BASELINE_RMS_LIMIT, "{name}, n = {n}, {}: rel. RMS {rms:e}", signal.name());
                assert!(parseval < BASELINE_PARSEVAL_LIMIT, "{name}, n = {n}, {}: Parseval {parseval:e}", signal.name());
            }
        }
    }
}

#[test]
fn rfft_round_trip_meets_the_plan_target() {
    for n in SIZES {
        let mut fft = RfftOption::new(n);
        let input = Signal::WhiteNoise.generate(n);
        let (re, im) = forward(&mut fft, &input);
        let mut output = vec![0.0; n];
        assert!(fft.inverse(&re, &im, &mut output));
        let error = max_abs_error(&input, &output);
        assert!(error < ROUND_TRIP_LIMIT, "n = {n}: round trip {error:e}");
    }
}

#[test]
fn rfft_meets_the_analyser_contract() {
    let window = analyser_window(ANALYSER_SIZE);
    for signal in Signal::ALL.into_iter().filter(|signal| signal.is_gated()) {
        let input = signal.generate(ANALYSER_SIZE);
        let old = analyser_bins(&mut AnalyserFft::new(ANALYSER_SIZE), &input, &window);
        let new = analyser_bins(&mut RfftOption::new(ANALYSER_SIZE), &input, &window);
        let deviation = contract_deviation(&new, &old);
        assert!(deviation < CONTRACT_EPSILON, "{}: contract deviation {deviation:e}", signal.name());
    }
}
