// Markdown tables shared by the Node runner and the browser report. Every helper returns lines.
import {CI_TARGET} from "./stats.mjs"

export const microseconds = (nanoseconds) => (nanoseconds / 1000).toFixed(nanoseconds < 10000 ? 2 : 1)

export const cell = (measure) => measure === undefined ? "–"
    : `${microseconds(measure.median)} ±${(measure.ci * 100).toFixed(1)} %${measure.ci > CI_TARGET ? " ⚠" : ""}`

export const sizeTable = (title, sizes, options, value, results) => [
    `### ${title}`, "",
    `| N | ${options.map(({name}) => name).join(" | ")} |`,
    `|---|${"---|".repeat(options.length)}`,
    ...sizes.map((n) => `| ${n} | ${options.map(({name}) =>
        value(results.find((result) => result.name === name && result.n === n))).join(" | ")} |`),
    ""]

export const environmentTable = (rows) =>
    ["## Environment", "", "| Key | Value |", "|---|---|", ...rows.map(([key, value]) => `| ${key} | ${value} |`)]

// `steps` holds ns per step; results without steps are skipped.
export const stepTable = (results) => {
    const stepped = results.filter((result) => result.steps !== undefined)
    return stepped.length === 0 ? [] : [
        "### Forward steps (stage-wise options): µs per step, median", "",
        "| Option | N | Steps | Largest step | All steps |", "|---|---|---|---|---|",
        ...stepped.map((result) => `| ${result.name} | ${result.n} | ${result.steps.length} | `
            + `${microseconds(Math.max(...result.steps))} | ${microseconds(result.steps.reduce((sum, value) => sum + value, 0))} |`)]
}
