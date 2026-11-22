// The worklet page's text: the question, the intro, the steps and one reading hint per table.

export const QUESTION = ["Does an FFT cost the same on the audio thread as in a Worker?",
    "The same module and options, timed in an AudioWorklet offline and in real time, next to the Worker."]

// Text in backticks renders as code.
export const INTRO = [
    ["Options", ["`rfft` (today, scalar), `realfft`, `simd`, `simd-o1o4`; N = 256, 1024, 4096, 16384; forward and inverse"]],
    ["Clock", ["The worklet has no `performance.now()`; a Worker spins it into shared memory, as the studio's DSP meter does. "
        + "That Worker keeps one core busy while this page is open"]],
    ["Method", ["Each render quantum runs one batch, with or without the FFT; a pair's difference ÷ calls is one sample. "
        + "Both batches read the clock twice, so its cost cancels"]],
    ["Load", ["A batch takes about a quarter of the render quantum, calibrated per round"]],
    ["Rounds", ["Options and sizes take turns in rounds; round 0 warms the code up and is not counted"]],
    ["Not here", ["Accuracy gates (`cargo test`), the decision overview (decision page)"]]
]

export const GLOSSARY = [
    ["µs per call", "Median time of one FFT in microseconds. Lower is better."],
    ["±", "Half-width of the 95 % bootstrap confidence interval of the median, relative to the median."],
    ["p99", "The 99th percentile of the per-pair samples: the slow tail on the audio thread."],
    ["÷ Worker", "Worklet time divided by the Worker time on this machine. 1.00 is the same speed."],
    ["same", "The ratio lies within the two confidence intervals added together."],
    ["dropped", "Pairs where the clock did not move during a batch (its Worker was descheduled); they are left out."]
]

export const HINTS = {
    environmentTable: "The clock tick is the smallest step the spinning clock showed on this thread; the worklet reads the same memory.",
    bitsTable: "A case is one option, size and signal: input, forward and inverse output hashed. The Worker's bits were checked against native by node bits.mjs.",
    ratioChart: "One line per option. On the dashed line the audio thread costs exactly what the Worker costs; below it the audio thread is faster.",
    tailChart: "How much slower the slowest 1 % of samples are than the median. Near 1 is a steady thread; spikes are stalls (other load, scheduling).",
    timeTable: "Per option and size: the Worker's time, then each worklet run and its ratio to the Worker.",
    ranking: "How many times as long realfft takes as simd-o1o4. Above the dashed line the library is more than 20 % slower, so the plan's "
        + "rule prefers the own kernel. If the lines of the three runs lie on each other, the Worker gives the same verdict as the audio thread."
}

export const STEPS = [
    {id: "environment", title: "Environment",
        what: "Checks isolation, core count, SIMD128 and starts the spinning clock.",
        why: "The worklet needs the clock in shared memory; a clock Worker on fewer than 4 cores would compete with the audio thread.",
        how: "Reads crossOriginIsolated and hardwareConcurrency, validates a SIMD module, starts the clock Worker and measures its tick.",
        expected: "Isolated, ≥ 4 cores, SIMD128, clock tick ≤ 20 µs."},
    {id: "module", title: "Load module",
        what: "Loads the module into the Worker and into an AudioWorklet.",
        why: "Both must run the same bytes; the worklet must find SIMD128 and every option.",
        how: "Compiles the module once, sends it to the worklet (or its bytes if the browser cannot send a module) and lists the options there.",
        expected: "The same option list in both, SIMD128 in the worklet."},
    {id: "bits", title: "Same bits on the audio thread",
        what: "Compares input, forward and inverse output of every case in the worklet with the Worker.",
        why: "An audio thread that flushes denormals or runs other code would give other results.",
        how: "Both hash every option, size and signal (FNV-1a over the f32 bits) and the page compares the hashes.",
        expected: "Every case identical."},
    {id: "worker", title: "Worker timings",
        what: "Time per call in a Worker, as on the decision page, for the same options and sizes.",
        why: "The reference for the worklet runs, on this machine and in this session.",
        how: "Batches with and without the FFT until the 95 % CI is ≤ 5 %.",
        expected: "CI ≤ 5 % for every point."},
    {id: "offline", title: "Worklet, offline",
        what: "Time per call on the audio thread of an OfflineAudioContext.",
        why: "Pure compute time on the render thread, without real-time pressure.",
        how: "Renders silence; each quantum runs one scheduled batch and reads the shared clock around it.",
        expected: "Within the CIs of the Worker time."},
    {id: "realtime", title: "Worklet, real time",
        what: "Time per call on the audio thread of a running AudioContext (48 kHz, interactive latency).",
        why: "The engine renders here; priority, frequency scaling and tails may differ from a Worker.",
        how: "As offline, in real time (about 25 s). Chrome also reports underruns.",
        expected: "Median within the CIs of the Worker; no underruns."},
    {id: "report", title: "Report",
        what: "All results of this run as one Markdown file.",
        why: "To compare browsers and attach to the issue.",
        how: "Builds the Markdown in the page and downloads it.",
        expected: "A file worklet-<browser>-<major version>.md is downloaded."}]
