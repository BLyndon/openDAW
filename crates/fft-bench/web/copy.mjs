// The page's explanatory text: the intro, the glossary and one reading hint per table and chart.

export const INTRO = [
    "The engine needs a faster FFT for WebAssembly (f32, real input, N = 256–16384). There are two ways to get one: "
    + "depend on the library realfft/rustfft, which has SIMD128 support, or keep a small kernel of our own, simd. "
    + "This page collects what is needed to choose between them.",
    "Options measured: the scalar FFTs on today's render path (analyser, rfft, signalsmith, and reverted, an earlier SIMD attempt) "
    + "as baselines; realfft, the library; simd, the own SIMD128 kernel; and simd-complex, the same kernel as a full complex "
    + "transform, the shape the time-stretch uses for two channels per call.",
    "Speed is measured live in this browser by the steps below. Accuracy, allocations, wasm size, no_std linking and "
    + "licences cannot be measured in a browser; they come from web/facts.json, which node facts.mjs generates from the "
    + "repository's tests and size builds.",
    "The page states facts and the thresholds of the plan (future-plans/simd-fft.md). It does not recommend an option. "
    + "Thresholds marked proposal or open are not settled yet."
]

export const GLOSSARY = [
    ["µs per call", "Median time of one FFT call in microseconds. Lower is better."],
    ["± x %", "Half-width of the 95 % confidence interval of that median, relative to it. Small means repeatable."],
    ["⚠", "The confidence interval stayed above 5 % after the maximum number of batches: treat the point with care or rerun it."],
    ["N", "Transform size in samples."],
    ["render quantum", "The 128-frame block the audio thread computes per call: 2.67 ms at 48 kHz. 100 % of it leaves no time for anything else."],
    ["complex option", "A full N-point complex transform. It can carry two real channels per call (left in re, right in im)."],
    ["log axis", "Each tick is a fixed factor (×2 for N, ×10 for time), so equal distances mean equal ratios."],
    ["plan / proposal / open", "Threshold status: plan = stated in the plan; proposal = suggested, not yet agreed; open = no value yet, "
    + "so the value is shown without a mark."],
    ["✔ / ✘", "The value meets or misses a plan or proposal threshold. Rows without a threshold carry no mark."]
]

export const HINTS = {
    overview: "One row per criterion. The realfft and simd columns are the two candidates, rfft is today's scalar FFT for reference. "
        + "Cells marked “run step …” fill in when that step has run; the source column says where each value comes from.",
    throughputTable: "Median µs per call for each option (column) and size (row), with the 95 % confidence interval. Lower is better; "
        + "“–” means the option has no such call.",
    throughputChart: "The same medians as lines. Both axes are logarithmic, so parallel lines mean a constant speed ratio. Lower is better.",
    libraryChart: "Each curve is realfft's time divided by that option's time. Above the dashed line realfft is more than 20 % slower; "
        + "below 1 it is faster.",
    stepsTable: "For options that split one transform into steps: time per step. The largest step is what one render quantum has to fit.",
    budgetChart: "Average share of one render quantum each consumer's FFTs would take with each option, from this browser's times. Lower is better.",
    budgetTable: "The same model as numbers, with the call pattern of each consumer.",
    environmentTable: "Whether this browser can measure at all. All three checks must pass for the timings to be trustworthy.",
    moduleTable: "The options compiled into the loaded wasm module, in registry order."
}
