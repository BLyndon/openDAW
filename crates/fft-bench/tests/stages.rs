// The outlook stages (`options::outlook::STAGES`): every stage passes the candidate gates, allocates nothing after
// `new`, and gives exactly the bits of the stage before it where its item leaves the arithmetic unchanged. Only O2
// (radix-8) changes the arithmetic, and only where log2(N/2) is odd; there it is held to the gates instead. The
// selection S0+O1+O4 leaves out O2, so it gives exactly the bits of S0.

use fft_bench::contract::{analyser_bins, analyser_window};
use fft_bench::metrics::{contract_deviation, max_abs_error, parseval_error, relative_rms, rms_gate, CONTRACT_EPSILON, ROUND_TRIP_LIMIT};
use fft_bench::options::analyser::AnalyserFft;
use fft_bench::options::outlook::batch::{RealFft4, LANES};
use fft_bench::options::outlook::STAGES;
use fft_bench::options::rfft::RfftOption;
use fft_bench::reference::dft;
use fft_bench::signals::Signal;
use fft_bench::{bins, RealFft, SIZES};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

const PARSEVAL_LIMIT: f64 = 1e-6;
const ANALYSER_SIZE: usize = 1024;

fn stage(name: &str, n: usize) -> Box<dyn RealFft> {
    (STAGES.iter().find(|entry| entry.name == name).expect("stage is registered").create)(n)
}

fn forward(fft: &mut dyn RealFft, input: &[f32]) -> (Vec<f32>, Vec<f32>) {
    let n = fft.size();
    let (mut re, mut im) = (vec![0.0; bins(n)], vec![0.0; bins(n)]);
    fft.forward(input, &mut re, &mut im);
    (re, im)
}

fn inverse(fft: &mut dyn RealFft, re: &[f32], im: &[f32]) -> Vec<f32> {
    let mut output = vec![0.0; fft.size()];
    assert!(fft.inverse(re, im, &mut output));
    output
}

fn bits(values: &[f32]) -> Vec<u32> {
    values.iter().map(|value| value.to_bits()).collect()
}

fn odd_log2_half(n: usize) -> bool {
    (n / 2).trailing_zeros() % 2 == 1
}

#[test]
fn every_stage_meets_the_gates() {
    for n in SIZES {
        let mut baseline = RfftOption::new(n);
        for signal in Signal::ALL.into_iter().filter(|signal| signal.is_gated()) {
            let input = signal.generate(n);
            let reference = dft(&input);
            let (base_re, base_im) = forward(&mut baseline, &input);
            let limit = rms_gate(relative_rms(&base_re, &base_im, &reference));
            for entry in STAGES.iter() {
                let mut fft = (entry.create)(n);
                let (re, im) = forward(fft.as_mut(), &input);
                let rms = relative_rms(&re, &im, &reference);
                assert!(rms <= limit, "{}, n = {n}, {}: rel. RMS {rms:e} above gate {limit:e}", entry.name, signal.name());
                let parseval = parseval_error(&input, &re, &im);
                assert!(parseval < PARSEVAL_LIMIT, "{}, n = {n}, {}: Parseval {parseval:e}", entry.name, signal.name());
                let error = max_abs_error(&input, &inverse(fft.as_mut(), &re, &im));
                assert!(error < ROUND_TRIP_LIMIT, "{}, n = {n}, {}: round trip {error:e}", entry.name, signal.name());
            }
        }
    }
}

#[test]
fn every_stage_meets_the_analyser_contract() {
    let window = analyser_window(ANALYSER_SIZE);
    for signal in Signal::ALL.into_iter().filter(|signal| signal.is_gated()) {
        let input = signal.generate(ANALYSER_SIZE);
        let old = analyser_bins(&mut AnalyserFft::new(ANALYSER_SIZE), &input, &window);
        for entry in STAGES.iter() {
            let deviation = contract_deviation(&analyser_bins((entry.create)(ANALYSER_SIZE).as_mut(), &input, &window), &old);
            assert!(deviation < CONTRACT_EPSILON, "{}, {}: contract deviation {deviation:e}", entry.name, signal.name());
        }
    }
}

// (earlier, later, whether the bits may differ at size n)
const CHAIN: [(&str, &str, fn(usize) -> bool); 6] = [("S0", "O1", |_| false), ("O1", "O2", odd_log2_half), ("O2", "O3", |_| false),
    ("O3", "O4", |_| false), ("O4", "O5", |_| false), ("O5", "O10", |_| false)];

#[test]
fn each_stage_keeps_the_bits_of_the_one_before() {
    for (earlier, later, may_differ) in CHAIN {
        for n in SIZES.into_iter().filter(|n| !may_differ(*n)) {
            for signal in Signal::ALL {
                let input = signal.generate(n);
                let (mut before, mut after) = (stage(earlier, n), stage(later, n));
                let (re, im) = forward(before.as_mut(), &input);
                let (later_re, later_im) = forward(after.as_mut(), &input);
                assert!(bits(&re) == bits(&later_re) && bits(&im) == bits(&later_im), "{earlier} → {later}, n = {n}, {}: forward bits", signal.name());
                let output = inverse(before.as_mut(), &re, &im);
                assert_eq!(bits(&output), bits(&inverse(after.as_mut(), &re, &im)), "{earlier} → {later}, n = {n}, {}: inverse bits", signal.name());
            }
        }
    }
}

#[test]
fn the_selection_keeps_the_bits_of_s0() {
    for n in SIZES {
        for signal in Signal::ALL {
            let input = signal.generate(n);
            let (mut base, mut selection) = (stage("S0", n), stage("S0+O1+O4", n));
            let (re, im) = forward(base.as_mut(), &input);
            let (selection_re, selection_im) = forward(selection.as_mut(), &input);
            assert!(bits(&re) == bits(&selection_re) && bits(&im) == bits(&selection_im), "n = {n}, {}: forward bits", signal.name());
            assert_eq!(bits(&inverse(base.as_mut(), &re, &im)), bits(&inverse(selection.as_mut(), &re, &im)), "n = {n}, {}: inverse bits", signal.name());
        }
    }
}

#[test]
fn radix8_changes_the_bits_only_where_it_applies() {
    let input = Signal::WhiteNoise.generate(1024);
    let (re, _) = forward(stage("O1", 1024).as_mut(), &input);
    let (radix8_re, _) = forward(stage("O2", 1024).as_mut(), &input);
    assert_ne!(bits(&re), bits(&radix8_re), "at N = 1024 the last two stages are merged, so rounding differs");
}

#[test]
fn every_batch_lane_gives_the_bits_of_its_own_transform() {
    let signals = [Signal::WhiteNoise, Signal::SineOffBin, Signal::Impulse, Signal::FullScaleNoise];
    for n in SIZES {
        let (m, mut batch, mut single) = (n / 2, RealFft4::new(n), stage("O10", n));
        let inputs = signals.map(|signal| signal.generate(n));
        let mut interleaved = vec![0.0; LANES * n];
        for (lane, input) in inputs.iter().enumerate() {
            input.iter().enumerate().for_each(|(index, value)| interleaved[LANES * index + lane] = *value);
        }
        let (mut re, mut im, mut output) = (vec![0.0; LANES * (m + 1)], vec![0.0; LANES * (m + 1)], vec![0.0; LANES * n]);
        batch.forward(&interleaved, &mut re, &mut im);
        let spectrum = (re.clone(), im.clone());
        batch.inverse(&spectrum.0, &spectrum.1, &mut output);
        for (lane, input) in inputs.iter().enumerate() {
            let lane_of = |values: &[f32]| values.iter().skip(lane).step_by(LANES).copied().collect::<Vec<f32>>();
            let (single_re, single_im) = forward(single.as_mut(), input);
            assert!(bits(&lane_of(&re)) == bits(&single_re) && bits(&lane_of(&im)) == bits(&single_im), "n = {n}, lane {lane}: forward bits");
            assert_eq!(bits(&lane_of(&output)), bits(&inverse(single.as_mut(), &single_re, &single_im)), "n = {n}, lane {lane}: inverse bits");
        }
    }
}

struct CountingAllocator;

thread_local! {
    static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
}

fn count() {
    let _ = ALLOCATIONS.try_with(|allocations| allocations.set(allocations.get() + 1));
}

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count();
        System.alloc(layout)
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count();
        System.alloc_zeroed(layout)
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        count();
        System.realloc(pointer, layout, new_size)
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        System.dealloc(pointer, layout)
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

fn allocations_during(action: impl FnOnce()) -> usize {
    let before = ALLOCATIONS.with(Cell::get);
    action();
    ALLOCATIONS.with(Cell::get) - before
}

#[test]
fn no_stage_allocates_after_plan_creation() {
    for n in SIZES {
        let input = Signal::WhiteNoise.generate(n);
        let (mut re, mut im, mut output) = (vec![0.0; bins(n)], vec![0.0; bins(n)], vec![0.0; n]);
        for entry in STAGES.iter() {
            let mut fft = (entry.create)(n);
            let allocations = allocations_during(|| {
                fft.forward(&input, &mut re, &mut im);
                fft.inverse(&re, &im, &mut output);
                fft.prepare_forward(&input);
                fft.forward_kernel(&input, &mut re, &mut im);
                fft.prepare_inverse(&re, &im);
                fft.inverse_kernel(&re, &im, &mut output);
            });
            assert_eq!(allocations, 0, "{}, n = {n}: allocations after new", entry.name);
        }
    }
}
