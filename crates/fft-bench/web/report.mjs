// The browser run as Markdown in the node.md format, so browser and Node results compare section by section.
// Browser timers are too coarse for single calls, so that table is left out and steps come from batches.
import {budgetReport, RENDER_QUANTUM_NS} from "../budget.mjs"
import {cell, environmentTable, sizeTable, stepTable} from "../markdown.mjs"
import {CI_TARGET, MAX_BATCHES} from "../stats.mjs"

export const buildReport = ({environment, options, sizes, results, steps, remarks = []}) => {
    const table = (title, value) => sizeTable(title, sizes, options, value, results)
    const times = (name, n) => {
        const result = results.find((entry) => entry.name === name && entry.n === n)
        return result?.forward === undefined ? undefined : {forward: result.forward.median, inverse: result.inverse?.median}
    }
    return [
        ...environmentTable(environment), "",
        ...remarks.length === 0 ? [] : ["## Remarks", "", ...remarks.map((remark) => `- ⚠ ${remark}`), ""],
        "## Wasm timings (browser)", "",
        `Throughput: median µs per call with the 95 % CI half-width; ⚠ marks a CI above ${CI_TARGET * 100} % after ${MAX_BATCHES} batches.`, "",
        ...table("Forward, throughput (µs)", (result) => cell(result?.forward)),
        ...table("Inverse, throughput (µs)", (result) => cell(result?.inverse)),
        ...table("Forward, % of the 128-frame render quantum at 48 kHz", (result) => result?.forward === undefined ? "–"
            : `${(result.forward.median / RENDER_QUANTUM_NS * 100).toFixed(2)} %`),
        ...stepTable(steps.map((entry) => ({...entry, steps: entry.steps.map((step) => step.median)}))), "",
        ...budgetReport(options, times)].join("\n")
}

export const reportFileName = ({name, version}) => `browser-${name.toLowerCase()}-${version.split(".")[0]}.md`
