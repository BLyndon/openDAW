// Render-budget model: turns measured times per call into the share of the 128-frame render quantum
// that each consumer's FFTs take, for every option able to serve that consumer. Pure functions only, so
// the Node runner and a browser page can share it. The call patterns come from the consumers' code.

export const RENDER_QUANTUM_NS = 128 / 48000 * 1e9

// `every`: the event repeats every that many render quanta. `channels`: real signals per event; a
// complex option carries two of them per call (re and im), a real option needs one call each.
// `split`: the consumer spreads one event's work over the quanta in between (no single-quantum peak).
export const CONSUMERS = [
    {
        name: "Analyser",
        current: "analyser",
        source: "dsp::analyser: L+R summed, one forward per 1024-frame frame",
        channels: 1,
        split: false,
        events: [{n: 1024, forward: 1, inverse: 0, every: 8}]
    },
    {
        name: "Time-stretch, per region",
        current: "signalsmith",
        source: "SignalsmithStretch::frame_step: L in re, R in im; forward and inverse per 1024-frame interval, in steps",
        channels: 2,
        split: true,
        events: [{n: 4096, forward: 1, inverse: 1, every: 8}]
    },
    {
        name: "Convolver",
        current: "rfft",
        source: "dsp::convolution Level::on_boundary: per channel, forward at step 0, inverse at the last step",
        channels: 2,
        split: false,
        events: [
            {n: 256, forward: 1, inverse: 1, every: 1},
            {n: 2048, forward: 1, inverse: 1, every: 8},
            {n: 16384, forward: 1, inverse: 1, every: 64}
        ]
    }
]

// Region counts for the time-stretch table: the counts measured in d02dc79b8, and the plan's proposal V = 16.
export const REGION_COUNTS = [1, 3, 5, 16]

const callsPerEvent = (consumer, complex) => complex ? Math.ceil(consumer.channels / 2) : consumer.channels

// `times(name, n)` returns {forward, inverse} in ns per call (inverse undefined if the option has none),
// or undefined if that size was not measured. Returns undefined if the option cannot serve the consumer.
export const consumerLoad = (consumer, option, times) => {
    let average = 0
    let peak = 0
    for (const event of consumer.events) {
        const time = times(option.name, event.n)
        if (time === undefined || (event.inverse > 0 && time.inverse === undefined)) {
            return undefined
        }
        const calls = callsPerEvent(consumer, option.complex)
        const forward = event.forward * time.forward * calls
        const inverse = event.inverse > 0 ? event.inverse * time.inverse * calls : 0
        average += (forward + inverse) / event.every
        // Worst case: every level's event lands in the same quantum; forward and inverse share one only
        // when the event repeats every quantum.
        peak += event.every === 1 ? forward + inverse : Math.max(forward, inverse)
    }
    return {average: average / RENDER_QUANTUM_NS, peak: consumer.split ? undefined : peak / RENDER_QUANTUM_NS}
}

const percent = (fraction) => `${(fraction * 100).toFixed(2)} %`

// Markdown lines for every consumer: average and worst-case share per option, and the difference to the
// option the consumer uses today.
export const budgetReport = (options, times) => {
    const lines = ["## Render budget per consumer", "",
        "Share of the 128-frame render quantum at 48 kHz taken by the consumer's FFTs alone. Average: spread over",
        "the repeat interval. Worst case: all events of one instance in the same quantum. Pack/unpack and",
        "windowing work around the FFT is not included. Time-stretch: split computation spreads its steps,",
        "so no worst case is given; see the step table for the largest single step.", ""]
    for (const consumer of CONSUMERS) {
        const loads = options.map((option) => ({option, load: consumerLoad(consumer, option, times)}))
            .filter(({load}) => load !== undefined)
        const current = loads.find(({option}) => option.name === consumer.current)
        if (current === undefined) {
            continue
        }
        lines.push(`### ${consumer.name}`, "", `Call pattern: ${consumer.source}.`, "")
        lines.push("| Option | Calls per event | Average | Worst case | Average vs current |", "|---|---|---|---|---|")
        for (const {option, load} of loads) {
            const marker = option.name === consumer.current ? " (current)" : ""
            const difference = load.average - current.load.average
            const versus = option.name === consumer.current ? "–"
                : `${difference <= 0 ? "−" : "+"}${percent(Math.abs(difference))} (${(current.load.average / load.average).toFixed(2)}×)`
            lines.push(`| ${option.name}${marker} | ${callsPerEvent(consumer, option.complex)} | ${percent(load.average)} `
                + `| ${load.peak === undefined ? "–" : percent(load.peak)} | ${versus} |`)
        }
        lines.push("")
        if (consumer.split) {
            lines.push(`Average for ${REGION_COUNTS.join(", ")} regions:`, "")
            lines.push(`| Option | ${REGION_COUNTS.map((count) => `${count} region${count === 1 ? "" : "s"}`).join(" | ")} |`)
            lines.push(`|---|${"---|".repeat(REGION_COUNTS.length)}`)
            for (const {option, load} of loads) {
                lines.push(`| ${option.name} | ${REGION_COUNTS.map((count) => percent(load.average * count)).join(" | ")} |`)
            }
            lines.push("")
        }
    }
    return lines
}
