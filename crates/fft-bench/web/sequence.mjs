// The browser page's fixed step order; a new result invalidates every later step.
export const STEPS = [
    {id: "environment", title: "Environment",
        purpose: "Can this browser measure at all: cross-origin isolated, a fine timer, SIMD128?",
        expected: "Cross-origin isolated, timer tick ≤ 20 µs, SIMD128 available."},
    {id: "module", title: "Load module",
        purpose: "Load the wasm module that Node measured and identify it.",
        expected: "Every registered option listed, module hash shown, module not older than its sources."},
    {id: "forward", title: "Forward throughput",
        purpose: "Time per forward call for every option and size, as wasm with SIMD128 in this browser.",
        expected: "CI ≤ 5 % for every point."},
    {id: "inverse", title: "Inverse throughput",
        purpose: "Time per inverse call for every option with an inverse and every size.",
        expected: "CI ≤ 5 % for every point; options without an inverse show –."},
    {id: "steps", title: "Steps",
        purpose: "Time per step of stage-wise options, which split one transform over several render quanta.",
        expected: "CI ≤ 5 % for the largest step of each option and size."},
    {id: "budget", title: "Render budget",
        purpose: "Share of the 128-frame render quantum each consumer would take, from this browser's times.",
        expected: "Derived from the throughput steps; nothing to check of its own."},
    {id: "report", title: "Report",
        purpose: "All results as one Markdown file in the node.md format, to keep next to the Node results.",
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
