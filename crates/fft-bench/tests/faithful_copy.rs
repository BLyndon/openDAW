// Copies must stand for their originals bit for bit, not just closely. The size-generic analyser copy
// against `AudioAnalyser` at its own size (1024); the reverted SIMD variant against today's
// `signalsmith::fft` (natively it runs the scalar `Simd4` fallback, which its commit states is bit-exact).

use dsp::analyser::AudioAnalyser;
use fft_bench::contract::{analyser_bins, analyser_window};
use fft_bench::options::{analyser::AnalyserFft, reverted::RevertedFft, signalsmith::SignalsmithFft};
use fft_bench::signals::{impulse, sine_on_bin, white_noise, Signal, NOISE_AMPLITUDE};
use fft_bench::{bins, RealFft, SIZES};

// The analyser's fixed frame size (`dsp::analyser::FFT_SIZE`, crate-private).
const N: usize = 1024;
// An impulse away from 0 makes every butterfly do real work (at 0 they all multiply zeros).
const OFF_CENTRE_IMPULSE: usize = 37;
// Any value <= 0 selects the analyser's default decay; irrelevant for a single frame anyway.
const USE_DEFAULT_DECAY: f32 = 0.0;

fn analyser_reference(signal: &[f32]) -> Vec<f32> {
    // L + R summing: right is silent, so left + 0.0 == left exactly.
    let mut analyser = AudioAnalyser::new(USE_DEFAULT_DECAY);
    analyser.process(signal, &vec![0.0; signal.len()]);
    analyser.bins().to_vec()
}

fn assert_bit_identical(name: &str, signal: &[f32]) {
    let expected = analyser_reference(signal);
    let actual = analyser_bins(&mut AnalyserFft::new(N), signal, &analyser_window(N));
    assert_eq!(actual.len(), expected.len());
    for (index, (got, want)) in actual.iter().zip(&expected).enumerate() {
        assert_eq!(got.to_bits(), want.to_bits(), "{name}: bin {index} differs ({got} vs {want})");
    }
}

#[test]
fn copy_matches_analyser_bits_for_sine_on_bin() {
    assert_bit_identical("sine on bin", &sine_on_bin(N));
}

#[test]
fn copy_matches_analyser_bits_for_white_noise() {
    assert_bit_identical("white noise", &white_noise(N, NOISE_AMPLITUDE));
}

#[test]
fn copy_matches_analyser_bits_for_off_centre_impulse() {
    assert_bit_identical("off-centre impulse", &impulse(N, OFF_CENTRE_IMPULSE));
}

#[test]
fn impulse_gives_a_flat_unit_spectrum_at_every_size() {
    // x[0] = 1: every butterfly multiplies a zero by the twiddle, so the result is exactly 1 + 0i.
    for n in SIZES {
        let mut fft = AnalyserFft::new(n);
        let mut re = vec![0.0; bins(n)];
        let mut im = vec![0.0; bins(n)];
        fft.forward(&impulse(n, 0), &mut re, &mut im);
        assert!(re.iter().all(|value| *value == 1.0), "n = {n}: real part not all 1");
        assert!(im.iter().all(|value| *value == 0.0), "n = {n}: imaginary part not all 0");
    }
}

#[test]
fn has_no_inverse() {
    let mut fft = AnalyserFft::new(N);
    assert!(!fft.inverse(&vec![0.0; bins(N)], &vec![0.0; bins(N)], &mut vec![0.0; N]));
}

#[test]
fn reverted_variant_matches_signalsmith_bits_both_directions() {
    for n in SIZES {
        let (mut reverted, mut current) = (RevertedFft::new(n), SignalsmithFft::new(n));
        for signal in Signal::ALL {
            let input = signal.generate(n);
            let (mut reverted_re, mut reverted_im) = (vec![0.0; bins(n)], vec![0.0; bins(n)]);
            let (mut current_re, mut current_im) = (vec![0.0; bins(n)], vec![0.0; bins(n)]);
            reverted.forward(&input, &mut reverted_re, &mut reverted_im);
            current.forward(&input, &mut current_re, &mut current_im);
            let bits = |values: &[f32]| values.iter().map(|value| value.to_bits()).collect::<Vec<u32>>();
            assert_eq!(bits(&reverted_re), bits(&current_re), "n = {n}, {}: forward re", signal.name());
            assert_eq!(bits(&reverted_im), bits(&current_im), "n = {n}, {}: forward im", signal.name());
            let (mut reverted_out, mut current_out) = (vec![0.0; n], vec![0.0; n]);
            reverted.inverse(&current_re, &current_im, &mut reverted_out);
            current.inverse(&current_re, &current_im, &mut current_out);
            assert_eq!(bits(&reverted_out), bits(&current_out), "n = {n}, {}: inverse", signal.name());
        }
    }
}
