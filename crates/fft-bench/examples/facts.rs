//! Accuracy gates and allocation counts per option as JSON, for `facts.mjs`: `cargo run --release --example facts`.
//! Same signals, sizes and thresholds as `tests/accuracy.rs` and `tests/allocation.rs`; JSON is written by hand.

use fft_bench::contract::{analyser_bins, analyser_window};
use fft_bench::metrics::{contract_deviation, max_abs_error, relative_rms, rms_gate, CONTRACT_EPSILON, ROUND_TRIP_LIMIT};
use fft_bench::options::{analyser::AnalyserFft, rfft::RfftOption, Role, ALL};
use fft_bench::reference::dft;
use fft_bench::signals::Signal;
use fft_bench::{bins, RealFft, SIZES};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

const BASELINE_RMS_LIMIT: f64 = 1e-6;
const ANALYSER_SIZE: usize = 1024;

struct CountingAllocator;

static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        System.alloc(layout)
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        System.alloc_zeroed(layout)
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        System.realloc(pointer, layout, new_size)
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        System.dealloc(pointer, layout)
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

fn allocations_during(action: impl FnOnce()) -> usize {
    let before = ALLOCATIONS.load(Ordering::Relaxed);
    action();
    ALLOCATIONS.load(Ordering::Relaxed) - before
}

fn forward(fft: &mut dyn RealFft, input: &[f32]) -> (Vec<f32>, Vec<f32>) {
    let n = fft.size();
    let (mut re, mut im) = (vec![0.0; bins(n)], vec![0.0; bins(n)]);
    fft.forward(input, &mut re, &mut im);
    (re, im)
}

/// Worst value, the tightest limit it was held to, and whether every value stayed within its own limit.
struct Check {
    worst: f64,
    limit: f64,
    pass: bool
}

impl Check {
    fn new() -> Self {
        Self { worst: 0.0, limit: f64::INFINITY, pass: true }
    }

    fn add(&mut self, value: f64, limit: f64) {
        self.worst = self.worst.max(value);
        self.limit = self.limit.min(limit);
        self.pass &= value <= limit;
    }

    fn json(&self, key: &str, show_limit: bool) -> String {
        let limit = if show_limit { format!("{:e}", self.limit) } else { "null".to_string() };
        format!(r#"{{"worst": {:e}, "{key}": {limit}, "pass": {}}}"#, self.worst, self.pass)
    }
}

fn option_json(index: usize) -> String {
    let entry = &ALL[index];
    let baseline = entry.role == Role::Baseline;
    let (mut rms, mut round_trip, mut has_inverse) = (Check::new(), Check::new(), false);
    let mut allocations = 0;
    for n in SIZES {
        let mut fft = (entry.create)(n);
        let noise = Signal::WhiteNoise.generate(n);
        let (mut re, mut im, mut output) = (vec![0.0; bins(n)], vec![0.0; bins(n)], vec![0.0; n]);
        // First calls on a fresh plan, so lazy allocation counts, as in tests/allocation.rs.
        allocations += allocations_during(|| fft.forward(&noise, &mut re, &mut im));
        allocations += allocations_during(|| {
            fft.inverse(&re, &im, &mut output);
        });
        allocations += allocations_during(|| {
            fft.prepare_forward(&noise);
            fft.forward_kernel(&noise, &mut re, &mut im);
            fft.prepare_inverse(&re, &im);
            fft.inverse_kernel(&re, &im, &mut output);
        });
        let mut reference_fft = RfftOption::new(n);
        for signal in Signal::ALL.into_iter().filter(|signal| signal.is_gated()) {
            let input = signal.generate(n);
            let reference = dft(&input);
            let (re, im) = forward(fft.as_mut(), &input);
            let limit = if baseline {
                BASELINE_RMS_LIMIT
            } else {
                let (base_re, base_im) = forward(&mut reference_fft, &input);
                rms_gate(relative_rms(&base_re, &base_im, &reference))
            };
            rms.add(relative_rms(&re, &im, &reference), limit);
        }
        (re, im) = forward(fft.as_mut(), &noise);
        if fft.inverse(&re, &im, &mut output) {
            has_inverse = true;
            round_trip.add(max_abs_error(&noise, &output), ROUND_TRIP_LIMIT);
        }
    }
    let window = analyser_window(ANALYSER_SIZE);
    let mut contract = Check::new();
    for signal in Signal::ALL.into_iter().filter(|signal| signal.is_gated()) {
        let input = signal.generate(ANALYSER_SIZE);
        let old = analyser_bins(&mut AnalyserFft::new(ANALYSER_SIZE), &input, &window);
        let new = analyser_bins((entry.create)(ANALYSER_SIZE).as_mut(), &input, &window);
        contract.add(contract_deviation(&new, &old), CONTRACT_EPSILON);
    }
    let round_trip = if has_inverse { round_trip.json("limit", true) } else { "null".to_string() };
    format!(r#""{}": {{"rms": {}, "roundTrip": {round_trip}, "contract": {}, "allocations": {allocations}}}"#,
        entry.name, rms.json("gate", !baseline), contract.json("limit", true))
}

fn main() {
    let options: Vec<String> = (0..ALL.len()).map(option_json).collect();
    println!(r#"{{"options": {{{}}}}}"#, options.join(", "));
}
