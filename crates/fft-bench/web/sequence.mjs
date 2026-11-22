// The browser page's fixed step order; a new result invalidates every later step.
export const STEPS = [
    {id: "environment", title: "Environment",
        what: "Checks that the page is cross-origin isolated, that the timer ticks finely enough, and that SIMD128 is available.",
        why: "Without isolation browsers coarsen the timer, and without SIMD128 the kernel cannot run as built: every later number would be wrong.",
        how: "Reads crossOriginIsolated, measures the smallest step of performance.now(), and validates a tiny SIMD module.",
        expected: "Cross-origin isolated, timer tick ≤ 20 µs, SIMD128 available."},
    {id: "module", title: "Load module",
        what: "Loads the same wasm module Node measured and lists the options it contains.",
        why: "The browser numbers must come from the same code as the Node and native numbers.",
        how: "Fetches the module, prints its SHA-256, and compares its build time with the Rust sources.",
        expected: "Every registered option listed, module hash shown, module not older than its sources."},
    {id: "forward", title: "Forward throughput",
        what: "Time per forward FFT call for every option and size.",
        why: "Speed is the main criterion: the speed-up over today's scalar FFT and the 20 % rule between realfft and simd.",
        how: "In a Worker, batches of calls are timed with and without the FFT, and the difference is divided by the number of calls. "
            + "Batches repeat until the median's 95 % confidence interval is ≤ 5 % or the batch limit is reached.",
        expected: "CI ≤ 5 % for every point."},
    {id: "inverse", title: "Inverse throughput",
        what: "Time per inverse FFT call for every option with an inverse and every size.",
        why: "The time-stretch and the convolver run an inverse for every forward, so both directions count.",
        how: "As the forward step, for the inverse call.",
        expected: "CI ≤ 5 % for every point; options without an inverse show –."},
    {id: "steps", title: "Steps",
        what: "Time per step for options that can split one transform over several render quanta.",
        why: "The time-stretch spreads one FFT over several quanta to avoid peaks; the largest step decides whether one quantum is enough.",
        how: "Each step of a stage-wise option is timed on its own, as in the throughput steps.",
        expected: "CI ≤ 5 % for the largest step of each option and size."},
    {id: "budget", title: "Render budget",
        what: "The share of the 128-frame render quantum each consumer's FFTs would take with each option.",
        why: "Microseconds alone do not say whether something fits in real time; the share of the audio thread's budget does.",
        how: "Combines this browser's times with each consumer's call pattern (sizes, calls per event, how often events repeat) from the engine code.",
        expected: "Derived from the throughput steps; nothing to check of its own."},
    {id: "report", title: "Report",
        what: "All results of this run, with the decision overview, as one Markdown file.",
        why: "A saved run can be compared with Node and other browsers and attached to the issue.",
        how: "Builds the Markdown in the page and downloads it.",
        expected: "A file browser-<browser>-<major version>.md is downloaded."}]

export const createSequence = () => {
    const entries = new Map(STEPS.map(({id}, index) => [id, {state: index === 0 ? "ready" : "locked", data: undefined}]))
    const index = (id) => STEPS.findIndex((step) => step.id === id)
    const running = () => [...entries.values()].some((entry) => entry.state === "running")
    const resetAfter = (id, nextReady) => STEPS.slice(index(id) + 1).forEach((step, offset) => {
        const entry = entries.get(step.id)
        entry.state = offset === 0 && nextReady ? "ready" : "locked"
        entry.data = undefined
    })
    const passed = (id) => ["ok", "warn"].includes(entries.get(id).state)
    const canRun = (id) => !running() && entries.get(id).state !== "locked" && (index(id) === 0 || passed(STEPS[index(id) - 1].id))
    return {
        state: (id) => entries.get(id).state,
        data: (id) => entries.get(id).data,
        reasons: (id) => entries.get(id).reasons ?? [],
        canRun,
        start: (id) => {
            if (!canRun(id)) {
                throw new Error(`step ${id} cannot run now`)
            }
            entries.get(id).state = "running"
        },
        finish: (id, {status, reasons, data}) => {
            Object.assign(entries.get(id), {state: status, reasons, data})
            resetAfter(id, status !== "fail")
        },
        replacePoint: (id, key, measure) => {
            entries.get(id).data[key] = measure
            resetAfter(id, passed(id))
        }
    }
}

// Runs one step; a failure keeps the step's earlier data, so a failed rerun of one point loses nothing.
export const runStep = async (sequence, id, work) => {
    sequence.start(id)
    const outcome = await Promise.resolve().then(work)
        .catch((error) => ({status: "fail", reasons: [error.message], data: sequence.data(id)}))
    sequence.finish(id, outcome)
    return outcome
}

// Runs every step in order from the first and stops at the first one that fails; returns that step's id.
export const runAll = async (sequence, run) => {
    for (const {id} of STEPS) {
        await run(id)
        if (sequence.state(id) === "fail") {
            return id
        }
    }
    return undefined
}
