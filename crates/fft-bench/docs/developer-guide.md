# Developer guide

For people changing the harness or adding a kernel: the everyday commands, how to add an option, and the rules
while working. A complete measurement run is in the [runbook](runbook.md), what is tested and why in the
[testing concept](testing-concept.md).

## Running the harness

All commands from `crates/fft-bench`. The crate is excluded from the workspace, so `cargo` here uses
its own lockfile and `target/`.

| Task                          | Command                                               |
|-------------------------------|-------------------------------------------------------|
| All tests (≈ 2 s)             | `cargo test`                                          |
| Accuracy tests only           | `cargo test --test accuracy`                          |
| Faithful-copy tests only      | `cargo test --test faithful_copy`                     |
| Allocation test only          | `cargo test --test allocation`                        |
| Accuracy report (Markdown)    | `cargo run --release --example report > report.md`    |
| Wasm build check              | `cargo check --target wasm32-unknown-unknown`         |
| Native benchmarks (≈ 4 min)   | `cargo bench`, filtered: `cargo bench -- forward/rfft` |
| Node benchmarks and budget (≈ 30 s) | `cargo build --release --target wasm32-unknown-unknown`, then `node run.mjs`; filtered: `node run.mjs --sizes 1024 --options rfft,realfft` |
| Node module tests             | `node --test *.test.mjs web/*.test.mjs`               |
| Facts for the page (minutes)  | `node facts.mjs` → `web/facts.json`; run after every code change |
| Browser page                  | `node web/serve.mjs`, then open `http://127.0.0.1:8080/` in each browser and press **Run all** |
| Binary size and `no_std` check (≈ 30 s) | `size/size.sh`, `size/nostd-check.sh`; `wasm-opt` required (`brew install binaryen`) |

Tests build with `opt-level = 3` (`[profile.test]`): the f64 reference DFT is O(n²) and too slow
unoptimised at n = 16384.

## Adding an option

`simd` entered this way; so does any other kernel.

1. **Implement `RealFft`** in `src/options/<name>.rs`: `new(n)` builds the plan and is the only method
   that may allocate; `forward` takes n samples and writes n/2 + 1 split bins, unnormalised; `inverse`
   returns `false` if the option has none. A full complex FFT can reuse `ComplexAsReal`.
2. **Register it** in `options::ALL` with its role. A candidate is `Role::Candidate`.
3. **Copies only:** add a bit-for-bit test against the original to `tests/faithful_copy.rs`.
4. **Run `cargo test`.** Candidates and the reference are picked up by the gate tests automatically.
5. **Mutation check:** break the option once on purpose (a sign, a twiddle, a scale) and confirm a test
   fails; then revert.
6. **Size and `no_std`:** add a stub to `size/stubs/<name>/` and its name to `size/size.sh` and
   `size/nostd-check.sh`. Without it, the overview shows "–" for size and `no_std`.
7. **Refresh the facts:** `node facts.mjs`, so the page's overview includes the option.

Benchmarks, the Node runner and the browser page read the same registry, so a registered option is
measured without further changes.

## Rules while working on the harness

- No change to production code (`dsp`, `signalsmith`, the engine). Copies live in the harness.
- f32 only, no allocation after plan creation, twiddles built outside the timed path.
- Small, focused commits; every commit keeps `cargo test` green and the wasm build check passing.
