// Checks of the stages page's data shaping and copy: node --test web/stages.test.mjs
import {test} from "node:test"
import assert from "node:assert/strict"
import {buildStagesReport, key, reportFileName, SIZES, speedupSeries, timeSeries} from "./stages.mjs"
import {INTRO, QUESTION, STAGE_TEXT, STEPS} from "./stages-copy.mjs"

const STAGES = ["S0", "O1", "O2", "O3", "O4", "O5", "O10", "O6", "S0+O1+O4"].map((name, stage) => ({stage, name, batch: name === "O6" ? 4 : 1}))
// S0 takes 1000 ns × N/1024, every later stage 10 % less than the one before.
const data = Object.fromEntries(SIZES.flatMap((n) => STAGES.map((stage, position) =>
    [key(stage.name, n), {median: 1000 * n / 1024 * 0.9 ** position, ci: 0.01}])))

test("timeSeries: one line per size, one point per stage in µs", () => {
    const series = timeSeries(STAGES, data)
    assert.deepEqual(series.map(({name}) => name), SIZES.map((n) => `N = ${n}`))
    assert.equal(series[0].points.length, STAGES.length)
    assert.deepEqual(series[0].points[0], [0, 1])
})

test("timeSeries: an unmeasured point stays undefined", () => {
    const missing = {...data}
    delete missing[key("O3", 2048)]
    assert.equal(timeSeries(STAGES, missing)[1].points[3][1], undefined)
})

test("speedupSeries: S0's time over the stage's time, 1 at S0", () => {
    const [first] = speedupSeries(STAGES, data)
    assert.equal(first.points[0][1], 1)
    assert.ok(Math.abs(first.points[2][1] - 1 / 0.81) < 1e-12)
})

test("buildStagesReport: environment, every stage, both directions and the speed-ups", () => {
    const markdown = buildStagesReport({environment: [["cpu", "test"]], stages: STAGES, forward: data, inverse: data})
    for (const title of ["## Environment", "## Stages", "### Forward (µs per transform)", "### Inverse (µs per transform)",
        "### Forward speed-up against S0", "### Inverse speed-up against S0"]) {
        assert.ok(markdown.includes(title), title)
    }
    assert.match(markdown, /\| 1024 \| 1\.00 ±1\.0 % \|/)
    assert.match(markdown, /\| 1024 \| 1\.00× \| 1\.11× \|/)
})

test("reportFileName: browser and major version", () => {
    assert.equal(reportFileName({name: "Chrome", version: "156.0.1"}), "stages-chrome-156.md")
})

test("the copy describes every stage, every step and pairs its backticks", () => {
    assert.deepEqual(Object.keys(STAGE_TEXT), STAGES.map(({name}) => name))
    assert.deepEqual(STEPS.map(({id}) => id), ["environment", "module", "forward", "inverse", "report"])
    for (const line of [...QUESTION, ...INTRO.flatMap(([label, lines]) => [label, ...lines])]) {
        assert.equal((line.match(/`/g) ?? []).length % 2, 0, line)
    }
})
