# fft-bench

Compares FFT implementations for the engine's WebAssembly build: how accurate and how fast each one is.

It exists to answer one question from `future-plans/simd-fft.md`: should the engine depend on the library
`realfft`/`rustfft`, or use a small SIMD128 kernel of its own (`simd`, a prototype in this crate)? Today's scalar
FFTs on the render path are measured alongside as baselines.

It is a standalone crate, excluded from the workspace, and changes no production code.

## Three ways in

**See the results.** A browser page runs every option and puts all decision criteria on one page.

```sh
cd crates/fft-bench
cargo build --release --target wasm32-unknown-unknown
node web/serve.mjs          # then open http://127.0.0.1:8080/ and press "Run all"
```

**Check that everything is correct** (about 10 s, plus about 30 s for `bits.mjs`):

```sh
cargo test                                   # accuracy gates, faithful copies, allocations
node --test *.test.mjs web/*.test.mjs        # runners, statistics, page modules
node bits.mjs                                # simd: wasm build gives the native bits (after the wasm build)
```

**Take a full measurement run** for the evaluation: follow the [runbook](docs/runbook.md) (about 30 minutes plus a
few minutes per browser).

The current results and what the analysis found are in `analysis/README.md` at the repository root.

## Documents

| Read this                                  | when you want to know …                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| [Testing concept](docs/testing-concept.md) | what is tested, in which order, against what, and where thresholds come from   |
| [Developer guide](docs/developer-guide.md) | the everyday commands, how to add an option, the rules while working          |
| [Runbook](docs/runbook.md)                 | how to take a complete measurement run, step by step, with expected results    |
| [Architecture](docs/architecture.md)       | how the code is organised: Rust library, options, JavaScript runners, the page |
| [SIMD kernel](docs/simd-kernel.md)         | how the prototype kernel works and what each optimisation is expected to gain  |
