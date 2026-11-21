# fft-bench

Benchmark and accuracy harness for FFT implementations. It runs every registered FFT option on the same
signals and sizes and reports how accurate and how fast each one is.

The options include the scalar FFTs on the engine's render path (`dsp::analyser`, `dsp::rfft`,
`signalsmith::fft`), so SIMD kernels can be compared against them. Background: `future-plans/simd-fft.md`.

Standalone crate, excluded from the workspace. It changes no production code.

## Quick start

```sh
cd crates/fft-bench
cargo test                                           # accuracy and faithful-copy tests, ≈ 2 s
cargo run --release --example report > report.md     # accuracy tables as Markdown
```

## Documents

| Document                                   | Content                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| [Testing concept](docs/testing-concept.md) | questions, options and roles, test levels, signals, metrics, thresholds and their origin |
| [Workflow](docs/workflow.md)               | evaluation flow, commands, adding an option, taking a measurement                        |
| [Architecture](docs/architecture.md)       | modules, the `RealFft` interface, registry, adapters, build setup, dependencies          |
| [Runbook](docs/runbook.md)                 | a complete measurement run step by step: commands, expected results, troubleshooting      |

## Status

| Part                                                              | State                |
| ----------------------------------------------------------------- | -------------------- |
| `RealFft` interface, option registry                              | done                 |
| Options: `analyser`, `rfft`, `signalsmith`, `reverted`, `realfft` | done                 |
| f64 reference DFT, test signals, metrics, analyser contract       | done                 |
| Accuracy tests, faithful-copy tests, accuracy report              | done                 |
| Allocation test                                                   | done                 |
| Native benchmarks (Criterion), environment record                 | done                 |
| Wasm exports and Node runner, per-stage timing                    | done                 |
| Budget-per-consumer report                                        | done                 |
| Binary size and `no_std` checks                                   | done                 |
| Browser page (Chrome, Firefox, Safari): `node web/serve.mjs`      | done                 |
