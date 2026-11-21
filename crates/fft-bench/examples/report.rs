//! Accuracy report as Markdown tables: `cargo run --release --example report > report.md`.
//! Worst value over the gated signals per option and size; denormal input listed on its own.

use fft_bench::contract::{analyser_bins, analyser_window};
use fft_bench::metrics::{contract_deviation, max_abs_error, parseval_error, relative_rms};
use fft_bench::options::{analyser::AnalyserFft, ALL};
use fft_bench::reference::dft;
use fft_bench::signals::Signal;
use fft_bench::{bins, RealFft, SIZES};

const ANALYSER_SIZE: usize = 1024;

/// Worst values of one option at one size.
struct Worst {
    rms: f64,
    parseval: f64,
    round_trip: Option<f64>,
    denormal_rms: f64
}

fn measure(fft: &mut dyn RealFft) -> Worst {
    let n = fft.size();
    let mut worst = Worst { rms: 0.0, parseval: 0.0, round_trip: None, denormal_rms: 0.0 };
    let (mut re, mut im) = (vec![0.0; bins(n)], vec![0.0; bins(n)]);
    for signal in Signal::ALL {
        let input = signal.generate(n);
        fft.forward(&input, &mut re, &mut im);
        let rms = relative_rms(&re, &im, &dft(&input));
        if signal.is_gated() {
            worst.rms = worst.rms.max(rms);
            worst.parseval = worst.parseval.max(parseval_error(&input, &re, &im));
        } else {
            worst.denormal_rms = worst.denormal_rms.max(rms);
        }
    }
    let noise = Signal::WhiteNoise.generate(n);
    let mut output = vec![0.0; n];
    fft.forward(&noise, &mut re, &mut im);
    if fft.inverse(&re, &im, &mut output) {
        worst.round_trip = Some(max_abs_error(&noise, &output));
    }
    worst
}

fn table(title: &str, results: &[(usize, Vec<Worst>)], value: impl Fn(&Worst) -> Option<f64>) {
    println!("### {title}\n");
    println!("| N | {} |", ALL.iter().map(|entry| entry.name).collect::<Vec<_>>().join(" | "));
    println!("|---|{}", "---|".repeat(ALL.len()));
    for (n, row) in results {
        let cells: Vec<String> = row.iter().map(|worst| value(worst).map_or("–".to_string(), |number| format!("{number:.1e}"))).collect();
        println!("| {n} | {} |", cells.join(" | "));
    }
    println!();
}

fn main() {
    let results: Vec<(usize, Vec<Worst>)> = SIZES.iter()
        .map(|&n| (n, ALL.iter().map(|entry| measure((entry.create)(n).as_mut())).collect())).collect();
    println!("## Accuracy\n");
    table("Relative RMS vs f64 DFT (worst gated signal)", &results, |worst| Some(worst.rms));
    table("Parseval error (worst gated signal)", &results, |worst| Some(worst.parseval));
    table("Round trip, white noise", &results, |worst| worst.round_trip);
    table("Relative RMS, denormal noise (report only)", &results, |worst| Some(worst.denormal_rms));
    println!("### Analyser contract, N = {ANALYSER_SIZE}\n");
    println!("| Signal | {} |", ALL.iter().map(|entry| entry.name).collect::<Vec<_>>().join(" | "));
    println!("|---|{}", "---|".repeat(ALL.len()));
    let window = analyser_window(ANALYSER_SIZE);
    for signal in Signal::ALL {
        let input = signal.generate(ANALYSER_SIZE);
        let old = analyser_bins(&mut AnalyserFft::new(ANALYSER_SIZE), &input, &window);
        let cells: Vec<String> = ALL.iter().map(|entry| {
            let new = analyser_bins((entry.create)(ANALYSER_SIZE).as_mut(), &input, &window);
            format!("{:.1e}", contract_deviation(&new, &old))
        }).collect();
        println!("| {} | {} |", signal.name(), cells.join(" | "));
    }
}
