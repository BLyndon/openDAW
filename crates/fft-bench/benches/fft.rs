//! Native benchmarks: `cargo bench` (all) or `cargo bench -- forward/rfft` (filtered).
//! Native numbers are for development only; `realfft` uses NEON/AVX here, not SIMD128.

use criterion::{BenchmarkId, Criterion, Throughput};
use dsp::analyser::AudioAnalyser;
use fft_bench::options::analyser::analyser_for;
use fft_bench::options::ALL;
use fft_bench::signals::Signal;
use fft_bench::{bins, SIZES};
use std::hint::black_box;
use std::time::{Duration, Instant};

const WARM_UP: Duration = Duration::from_secs(1);
const MEASUREMENT: Duration = Duration::from_secs(2);
const ANALYSER_SIZE: usize = 1024;
// Any value <= 0 selects the analyser's default decay.
const USE_DEFAULT_DECAY: f32 = 0.0;

enum Phase {
    Prepare,
    Call
}

/// Times only `Phase::Call`, `iterations` times; `Phase::Prepare` runs before each call, untimed. In-place
/// kernels destroy their input, so every call needs fresh data. One closure handles both phases because
/// both need the same `&mut` option. Each sample includes one `Instant` pair; the `timer` group shows its cost.
fn per_call(iterations: u64, step: &mut dyn FnMut(Phase)) -> Duration {
    let mut total = Duration::ZERO;
    for _ in 0..iterations {
        step(Phase::Prepare);
        let start = Instant::now();
        step(Phase::Call);
        total += start.elapsed();
    }
    total
}

fn forward(criterion: &mut Criterion) {
    let mut group = criterion.benchmark_group("forward");
    for n in SIZES {
        let input = Signal::WhiteNoise.generate(n);
        let (mut re, mut im) = (vec![0.0; bins(n)], vec![0.0; bins(n)]);
        group.throughput(Throughput::Elements(n as u64));
        for entry in ALL.iter() {
            let mut fft = (entry.create)(n);
            group.bench_function(BenchmarkId::new(entry.name, n), |bencher| bencher.iter_custom(|iterations| {
                per_call(iterations, &mut |phase| match phase {
                    Phase::Prepare => fft.prepare_forward(&input),
                    Phase::Call => fft.forward_kernel(black_box(&input), &mut re, &mut im)
                })
            }));
        }
    }
    group.finish();
}

fn inverse(criterion: &mut Criterion) {
    let mut group = criterion.benchmark_group("inverse");
    for n in SIZES {
        let input = Signal::WhiteNoise.generate(n);
        let (mut re, mut im, mut output) = (vec![0.0; bins(n)], vec![0.0; bins(n)], vec![0.0; n]);
        group.throughput(Throughput::Elements(n as u64));
        for entry in ALL.iter() {
            let mut fft = (entry.create)(n);
            fft.forward(&input, &mut re, &mut im);
            if !fft.inverse(&re, &im, &mut output) {
                continue;
            }
            group.bench_function(BenchmarkId::new(entry.name, n), |bencher| bencher.iter_custom(|iterations| {
                per_call(iterations, &mut |phase| match phase {
                    Phase::Prepare => fft.prepare_inverse(&re, &im),
                    Phase::Call => {
                        fft.inverse_kernel(black_box(&re), &im, &mut output);
                    }
                })
            }));
        }
    }
    group.finish();
}

/// The cost of one `Instant::now()` + `elapsed()` pair around an empty call.
fn timer(criterion: &mut Criterion) {
    criterion.bench_function("timer/instant_pair", |bencher| bencher.iter_custom(|iterations| {
        per_call(iterations, &mut |_| {})
    }));
}

/// Does the copy run as fast as `AudioAnalyser`? Both get one full frame per call through the same
/// `process` path: sum L+R, window, FFT, magnitudes.
fn analyser_fidelity(criterion: &mut Criterion) {
    let mut group = criterion.benchmark_group("analyser_fidelity");
    let left = Signal::WhiteNoise.generate(ANALYSER_SIZE);
    let right = Signal::SineOnBin.generate(ANALYSER_SIZE);
    let mut original = Box::new(AudioAnalyser::new(USE_DEFAULT_DECAY));
    group.bench_function("original", |bencher| bencher.iter(|| original.process(black_box(&left), &right)));
    let mut copy = analyser_for(ANALYSER_SIZE);
    group.bench_function("copy", |bencher| bencher.iter(|| copy.process(black_box(&left), &right)));
    group.finish();
}

fn main() {
    println!("{}", fft_bench::env::markdown());
    let mut criterion = Criterion::default().warm_up_time(WARM_UP).measurement_time(MEASUREMENT).configure_from_args();
    timer(&mut criterion);
    analyser_fidelity(&mut criterion);
    forward(&mut criterion);
    inverse(&mut criterion);
    criterion.final_summary();
}
