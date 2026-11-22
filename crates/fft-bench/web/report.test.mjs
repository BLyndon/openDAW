// Checks of the browser report: node --test web/report.test.mjs
import {test} from "node:test"
import assert from "node:assert/strict"
import {buildReport, reportFileName} from "./report.mjs"

const options = [{option: 0, name: "analyser", complex: true}, {option: 1, name: "rfft", complex: false}]
const sizes = [1024, 4096]
const measure = (median) => ({median, ci: 0.01, batches: 30})
const results = sizes.flatMap((n) => [
    {name: "analyser", n, forward: measure(n * 11), inverse: undefined},
    {name: "rfft", n, forward: measure(n * 7), inverse: measure(n * 7)}])
const steps = [{name: "rfft", n: 1024, steps: [measure(1000), measure(3000)]}]
const report = buildReport({environment: [["browser", "Safari 26.1"]], options, sizes, results, steps})

test("sections appear in the node.md order", () => {
    const headings = ["## Environment", "## Wasm timings (browser)", "### Forward, throughput (µs)", "### Inverse, throughput (µs)",
        "### Forward, % of the 128-frame render quantum at 48 kHz", "### Forward steps", "## Render budget per consumer"]
    const positions = headings.map((heading) => report.indexOf(heading))
    assert.ok(positions.every((position) => position >= 0), `missing: ${headings.filter((_, index) => positions[index] < 0)}`)
    assert.deepEqual([...positions].sort((left, right) => left - right), positions)
})

test("an option without an inverse shows a dash", () => {
    const inverse = report.slice(report.indexOf("### Inverse"), report.indexOf("### Forward, %"))
    assert.match(inverse, /\| 1024 \| – \| 7\.17 ±1\.0 % \|/)
})

test("no single-call table", () => {
    assert.doesNotMatch(report, /single call/i)
})

test("steps come from the measured medians", () => {
    assert.match(report, /\| rfft \| 1024 \| 2 \| 3\.00 \| 4\.00 \|/)
})

test("the budget covers the analyser", () => {
    assert.match(report, /### Analyser/)
})

test("reportFileName: browser and major version, lower case", () => {
    assert.equal(reportFileName({name: "Safari", version: "26.1"}), "browser-safari-26.md")
})

test("remarks of warned steps are carried into the report, right after the environment", () => {
    const withRemarks = buildReport({environment: [["browser", "Chrome 156"]], options, sizes, results, steps,
        remarks: ["Forward throughput: tab was hidden", "Load module: module older than its sources"]})
    const remarks = withRemarks.indexOf("## Remarks")
    assert.ok(remarks > withRemarks.indexOf("## Environment") && remarks < withRemarks.indexOf("## Wasm timings"))
    assert.match(withRemarks, /- ⚠ Forward throughput: tab was hidden/)
    assert.doesNotMatch(report, /## Remarks/)
})

test("the report starts with the decision overview and the glossary", () => {
    const withOverview = buildReport({environment: [["browser", "Safari 26.1"]], options, sizes, results, steps,
        overview: ["| Criterion | realfft |", "|---|---|", "| Speed-up | 5.9× |"]})
    const overview = withOverview.indexOf("## Decision overview")
    assert.ok(overview > withOverview.indexOf("## Environment"))
    assert.ok(overview < withOverview.indexOf("## Wasm timings"))
    assert.match(withOverview, /\| Speed-up \| 5\.9× \|/)
    assert.match(withOverview, /- \*\*render quantum\*\*:/)
})

test("without an overview the report has no empty overview section", () => {
    assert.doesNotMatch(report, /## Decision overview/)
})
