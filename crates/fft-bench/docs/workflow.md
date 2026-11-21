# Workflow

How to work with the harness: running it, adding an option, and taking a measurement.

## Evaluation flow

```mermaid
flowchart TD
    A[Option added to the registry] --> B{Faithful copy?}
    B -- yes --> C[Bit-for-bit test against the original]
    B -- no --> D[Accuracy gates]
    C --> D
    D -- fails --> X[Fix or drop the option]
    D -- passes --> E[Native benchmarks<br/>development only]
    E --> F[Node, wasm32 + simd128<br/>preliminary]
    F --> G[AudioWorklet in Chrome, Firefox, Safari<br/>the numbers that count]
    G --> H[Budget per consumer]
    H --> I[Decision with the maintainer]
```

An option only reaches the performance steps once it passes every accuracy gate. The harness produces
the numbers at each step; the person running it compares them and decides. Node numbers alone are not
enough for that: the reverted SIMD pass looked fine in Node and was slow in the browser.

## Running the harness

All commands from `crates/fft-bench`. The crate is excluded from the workspace, so `cargo` here uses
its own lockfile and `target/`.

| Task                          | Command                                               | Status  |
|-------------------------------|-------------------------------------------------------|---------|
| All tests (≈ 2 s)             | `cargo test`                                          | ready   |
| Accuracy tests only           | `cargo test --test accuracy`                          | ready   |
| Faithful-copy tests only      | `cargo test --test faithful_copy`                     | ready   |
| Allocation test only          | `cargo test --test allocation`                        | ready   |
| Accuracy report (Markdown)    | `cargo run --release --example report > report.md`    | ready   |
| Wasm build check              | `cargo check --target wasm32-unknown-unknown`         | ready   |
| Native benchmarks             | `cargo bench`                                         | planned |
| Node benchmarks               | build the wasm module, then `node run.mjs <module>`   | planned |
| Binary size and `no_std` check| `size/size.sh`, `size/nostd-check.sh`                 | planned |

Tests build with `opt-level = 3` (`[profile.test]`): the f64 reference DFT is O(n²) and too slow
unoptimised at n = 16384.

## Adding an option

The Day-2 prototype enters this way; so would any other kernel.

1. **Implement `RealFft`** in `src/options/<name>.rs`: `new(n)` builds the plan and is the only method
   that may allocate; `forward` takes n samples and writes n/2 + 1 split bins, unnormalised; `inverse`
   returns `false` if the option has none. A full complex FFT can reuse `ComplexAsReal`.
2. **Register it** in `options::ALL` with its role. A candidate is `Role::Candidate`.
3. **Copies only:** add a bit-for-bit test against the original to `tests/faithful_copy.rs`.
4. **Run `cargo test`.** Candidates and the reference are picked up by the gate tests automatically.
5. **Mutation check:** break the option once on purpose (a sign, a twiddle, a scale) and confirm a test
   fails; then revert.
6. **Run the report** and compare its column with the baselines.

Benchmarks and the wasm runner read the same registry, so a registered option is measured without
further changes (once those parts exist).

## Taking a measurement

1. **Clean tree:** commit or stash first, so the build hash identifies the code that was measured.
2. **Environment:** record CPU, OS, `rustc`, `node` and browser versions, git hash and dirty flag,
   `RUSTFLAGS`. Planned to be printed automatically by every runner.
3. **Warm runs only:** discard the warm-up calls; take the median of many runs and the 95 % confidence
   interval; repeat until its half-width is ≤ 5 %.
4. **Browsers by hand where needed:** Playwright's WebKit is not Safari; Safari is run manually.
5. **Store results outside the crate.** Measurements belong to the evaluation, not to the harness code.

## Rules while working on the harness

- No change to production code (`dsp`, `signalsmith`, the engine). Copies live in the harness.
- f32 only, no allocation after plan creation, twiddles built outside the timed path.
- Small, focused commits; every commit keeps `cargo test` green and the wasm build check passing.
