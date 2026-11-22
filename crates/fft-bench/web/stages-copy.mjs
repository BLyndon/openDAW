// The stages page's text: the question, the intro, one line per stage, the steps and one reading hint per table and chart.

export const QUESTION = ["How much does each outlook item add to the SIMD128 kernel?",
    "Each stage has every item before it. f32, real input, N = 1024–16384, WebAssembly."]

// Text in backticks renders as code.
export const INTRO = [
    ["Stages", ["`S0` is `simd` as on the decision page; each later stage adds one item of `docs/simd-outlook.md` on top of all before it"]],
    ["Not stages", ["O7 (window and magnitude fused into the kernel) changes the result, O8 only concerns N = 256, O9 is code analysis without code"]],
    ["Same results", ["Every stage passes the accuracy gates; all but O2 give exactly the bits of the stage before (`tests/stages.rs`)"]],
    ["Selection", ["`S0+O1+O4` (last point): only the two items that paid in Chrome, on top of `simd`; same bits as `S0`"]],
    ["Code", ["`src/options/outlook/kernel.rs` (O1–O10, one bit each), `src/options/outlook/batch.rs` (O6)"]],
    ["Prototype", ["For measuring only; nothing here is meant for the engine as it is"]]
]

// One line per stage, by the name the module reports.
export const STAGE_TEXT = {
    S0: "simd: radix-4 Stockham with f32x4 butterflies and a separate twist pass",
    O1: "forward: last stage and twist in one pass",
    O2: "radix-8 last stage where log2(N/2) is odd (N = 1024, 4096, 16384); N = 2048 and 8192 are unchanged",
    O3: "inverse: pre-twist and first stage in one pass",
    O4: "broadcast twiddles with one v128.load32_splat",
    O5: "the caller's buffers as one of the two ping-pong buffers",
    O10: "work buffers and tables on 16-byte boundaries",
    O6: "four transforms per call, one per lane; time per transform = time per call ÷ 4; interleaving the data is not timed",
    "S0+O1+O4": "not cumulative: simd with only O1 and O4, the two items that paid in Chrome"
}

export const GLOSSARY = [
    ["µs per transform", "Median time of one FFT in microseconds; for O6 the time of one call divided by its four transforms. Lower is better."],
    ["± x %", "Half-width of the 95 % confidence interval of that median, relative to it. Small means repeatable."],
    ["⚠", "The confidence interval stayed above 5 % after the maximum number of batches: treat the point with care or rerun it."],
    ["speed-up", "S0's time divided by the stage's time at the same N. Above 1 the stage is faster than simd."],
    ["log axis", "Each tick is a fixed factor (×10 for time), so equal distances mean equal ratios."]
]

export const STEPS = [
    {id: "environment", title: "Environment",
        what: "Checks that the page is cross-origin isolated, that the timer ticks finely enough, and that SIMD128 is available.",
        why: "Without isolation browsers coarsen the timer, and without SIMD128 the kernels cannot run as built.",
        how: "Reads crossOriginIsolated, measures the smallest step of performance.now(), and validates a tiny SIMD module.",
        expected: "Cross-origin isolated, timer tick ≤ 20 µs, SIMD128 available."},
    {id: "module", title: "Load module",
        what: "Loads the wasm module and lists the stages it contains.",
        why: "The numbers must come from the code the tests checked.",
        how: "Fetches the module, prints its SHA-256, and compares its build time with the Rust sources.",
        expected: "Nine stages listed, module not older than its sources."},
    {id: "forward", title: "Forward by stage",
        what: "Time per forward FFT for every stage and size.",
        why: "Shows what each item adds, and whether it pays at every size.",
        how: "In a Worker, batches of calls are timed with and without the FFT, as on the decision page; O6's time is divided by its four transforms.",
        expected: "CI ≤ 5 % for every point."},
    {id: "inverse", title: "Inverse by stage",
        what: "Time per inverse FFT for every stage and size.",
        why: "O3 changes only the inverse, O1 only the forward; the time-stretch runs both.",
        how: "As the forward step, for the inverse call.",
        expected: "CI ≤ 5 % for every point."},
    {id: "report", title: "Report",
        what: "All results of this run as one Markdown file.",
        why: "A saved run can be compared with other browsers and attached to the issue.",
        how: "Builds the Markdown in the page and downloads it.",
        expected: "A file stages-<browser>-<major version>.md is downloaded."}]

export const HINTS = {
    timeChart: "One line per N: time per transform at each stage, left to right in the order the items are added. "
        + "The y-axis is logarithmic, so a drop of the same height is the same factor at every N. Lower is better.",
    speedupChart: "Each line is S0's time divided by the stage's time at that N. A step up means the item helped, a step down that it cost time.",
    table: "Median µs per transform for each stage (row) and size (column), with the 95 % confidence interval.",
    environmentTable: "Whether this browser can measure at all. All three checks must pass for the timings to be trustworthy.",
    moduleTable: "The stages compiled into the loaded module, in the order the items are added."
}
