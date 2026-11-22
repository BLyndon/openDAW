//! Native reference bits of the SIMD kernel for `bits.mjs`, one JSON line per case: `cargo run --release --example bits`.
//! Each case runs as `wasm::setup_signal` does: forward, then the inverse of that spectrum. Values are f32 bits as
//! little-endian hex, the byte order of wasm memory.

use fft_bench::options::outlook::STAGES;
use fft_bench::options::ALL;
use fft_bench::signals::Signal;
use fft_bench::{bins, RealFft, SIZES};

const OPTIONS: [&str; 3] = ["simd", "simd-complex", "simd-o1o4"];

fn hex(values: &[f32]) -> String {
    values.iter().flat_map(|value| value.to_le_bytes()).map(|byte| format!("{byte:02x}")).collect()
}

/// `source` is the JSON field that tells `bits.mjs` which setup export to call: `"option": i` or `"stage": i`.
fn print_cases(source: &str, name: &str, create: fn(usize) -> Box<dyn RealFft>) {
    for n in SIZES {
        for (signal, kind) in Signal::ALL.iter().enumerate() {
            let mut fft = create(n);
            let input = kind.generate(n);
            let (mut re, mut im, mut output) = (vec![0.0; bins(n)], vec![0.0; bins(n)], vec![0.0; n]);
            fft.forward(&input, &mut re, &mut im);
            assert!(fft.inverse(&re, &im, &mut output), "{name} has an inverse");
            println!(r#"{{{source}, "name": "{name}", "n": {n}, "signal": {signal}, "signalName": "{}", "input": "{}", "re": "{}", "im": "{}", "output": "{}"}}"#,
                kind.name(), hex(&input), hex(&re), hex(&im), hex(&output));
        }
    }
}

fn main() {
    for name in OPTIONS {
        let option = ALL.iter().position(|entry| entry.name == name).expect("option is registered");
        print_cases(&format!(r#""option": {option}"#), name, ALL[option].create);
    }
    for (stage, entry) in STAGES.iter().enumerate() {
        print_cases(&format!(r#""stage": {stage}"#), &format!("stage {}", entry.name), entry.create);
    }
}
