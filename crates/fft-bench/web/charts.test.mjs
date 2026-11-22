// Checks of the SVG charts: node --test web/charts.test.mjs
import {test} from "node:test"
import assert from "node:assert/strict"
import {barChart, lineChart} from "./charts.mjs"

const count = (text, pattern) => (text.match(pattern) ?? []).length
const SIZES = [256, 1024, 4096, 16384]
const series = (name, slot, factor) => ({name, slot, points: SIZES.map((n) => [n, n * factor])})

test("lineChart: one path per series, coloured by the series slot", () => {
    const svg = lineChart({series: [series("rfft", 2, 0.007), series("realfft", 5, 0.0015)], xLabel: "N", yLabel: "µs", logX: true, logY: true})
    assert.ok(svg.startsWith("<svg"))
    assert.equal(count(svg, /<path class="line"/g), 2)
    assert.match(svg, /stroke="var\(--series-2\)"/)
    assert.match(svg, /stroke="var\(--series-5\)"/)
})

test("lineChart: log axis labels the smallest and largest size", () => {
    const svg = lineChart({series: [series("rfft", 1, 0.007)], xLabel: "N", yLabel: "µs", logX: true, logY: true})
    assert.match(svg, />256</)
    assert.match(svg, />16384</)
})

test("lineChart: unmeasured points are skipped, not drawn at zero", () => {
    const gappy = {name: "analyser", slot: 1, points: [[256, 2], [1024, undefined], [4096, 50]]}
    const svg = lineChart({series: [gappy], xLabel: "N", yLabel: "µs", logX: true, logY: true})
    assert.equal(count(svg, /<circle class="point"/g), 2)
})

test("lineChart: every point carries a hover title, and two or more series get a legend", () => {
    const svg = lineChart({series: [series("rfft", 2, 0.007), series("realfft", 5, 0.0015)], xLabel: "N", yLabel: "µs", logX: true, logY: true})
    assert.equal(count(svg, /<title>/g), 2 * SIZES.length)
    assert.equal(count(svg, /class="legend-item"/g), 2)
})

test("lineChart: categorical x ticks label the axis and the hover titles", () => {
    const stages = {name: "N = 1024", slot: 1, points: [[0, 0.9], [1, 0.8], [2, 0.7]]}
    const svg = lineChart({series: [stages], xLabel: "stage", yLabel: "µs", logX: false, logY: true, xTicks: [[0, "S0"], [1, "O1"], [2, "O2"]]})
    for (const label of ["S0", "O1", "O2"]) {
        assert.match(svg, new RegExp(`>${label}</text>`))
    }
    assert.match(svg, /<title>N = 1024, O1: 0\.8 µs<\/title>/)
})

test("barChart: one bar per group and option with its value, gaps between bars", () => {
    const groups = ["Analyser", "Time-stretch", "Convolver"].map((name) => ({name, bars: [
        {name: "rfft", slot: 2, value: 0.8}, {name: "realfft", slot: 5, value: 0.2}]}))
    const svg = barChart({groups, yLabel: "% of the render quantum", unit: " %"})
    assert.equal(count(svg, /<path class="bar"[^>]*data-value=/g), 6)
    assert.match(svg, />Time-stretch</)
})

test("barChart: the axis reaches the largest value, so no bar rises above the plot", () => {
    const svg = barChart({groups: [{name: "Convolver", bars: [{name: "rfft", slot: 2, value: 0.84}]}], yLabel: "%", unit: " %"})
    const tops = [...svg.matchAll(/<path class="bar" d="M[\d.]+,[\d.]+V(-?[\d.]+)/g)].map((match) => Number(match[1]))
    assert.equal(tops.length, 1)
    assert.ok(tops.every((top) => top >= 40), `bar tops ${tops}`)
})

test("lineChart: the last x label stays inside the chart", () => {
    const svg = lineChart({series: [series("rfft", 1, 0.007)], xLabel: "N", yLabel: "µs", logX: true, logY: true})
    const [, x] = svg.match(/<text x="([\d.]+)"[^>]*>16384</)
    assert.ok(Number(x) + 20 <= 640, `label at ${x}`)
})

test("barChart: unmeasured bars are left out", () => {
    const svg = barChart({groups: [{name: "Analyser", bars: [{name: "rfft", slot: 2, value: undefined}, {name: "realfft", slot: 5, value: 0.2}]}],
        yLabel: "%", unit: " %"})
    assert.equal(count(svg, /<path class="bar"/g), 1)
})

test("barChart: the legend lists only options that have a bar", () => {
    const groups = [{name: "Time-stretch", bars: [{name: "analyser", slot: 1, value: undefined}, {name: "rfft", slot: 2, value: 0.6},
        {name: "realfft", slot: 5, value: 0.1}]}]
    const svg = barChart({groups, yLabel: "%", unit: " %"})
    assert.equal(count(svg, /class="legend-item"/g), 2)
    assert.doesNotMatch(svg, />analyser</)
})

test("lineChart: a long legend wraps into rows inside the chart and moves the plot down", () => {
    const names = ["analyser", "rfft", "signalsmith", "reverted", "realfft", "simd", "simd-complex"]
    const svg = lineChart({series: names.map((name, index) => series(name, index + 1, 0.001 * (index + 1))), xLabel: "N", yLabel: "µs",
        logX: true, logY: true})
    const items = [...svg.matchAll(/class="legend-item" transform="translate\(([\d.]+),([\d.]+)\)"><rect[^>]*\/><text[^>]*>([^<]+)</g)]
    assert.equal(items.length, names.length)
    assert.ok(items.every(([, x, , name]) => Number(x) + 18 + name.length * 7 <= 640), "every item ends inside the chart")
    assert.ok(new Set(items.map(([, , y]) => y)).size > 1, "the items wrap into a second row")
    const [, height] = svg.match(/viewBox="0 0 640 ([\d.]+)"/)
    assert.ok(Number(height) > 320, "the chart grows by the extra rows")
})

test("lineChart: a reference line is drawn at its value and the axis reaches it", () => {
    const svg = lineChart({series: [{name: "realfft ÷ simd", slot: 5, points: [[256, 0.5], [1024, 0.8]]}], xLabel: "N", yLabel: "ratio",
        logX: true, logY: false, reference: {value: 1.2, label: "20 % limit"}})
    assert.equal(count(svg, /<line class="reference"/g), 1)
    assert.match(svg, />20 % limit</)
    const [, y] = svg.match(/<line class="reference"[^>]*y1="([\d.]+)"/)
    assert.ok(Number(y) >= 40, `reference at ${y} lies inside the plot`)
})

test("lineChart: yMin starts a linear axis above zero, values below it widen the axis", () => {
    const series = [{name: "a", slot: 1, points: [[256, 0.9], [1024, 1.05]]}]
    const labels = (svg) => [...svg.matchAll(/text-anchor="end" fill="var\(--text-muted\)" font-size="11">([^<]+)</g)].map((match) => Number(match[1]))
    assert.equal(Math.min(...labels(lineChart({series, xLabel: "N", yLabel: "r", logX: true, logY: false, yMin: 0.8}))), 0.8)
    assert.equal(Math.min(...labels(lineChart({series, xLabel: "N", yLabel: "r", logX: true, logY: false, yMin: 0.95}))), 0.9)
    assert.equal(Math.min(...labels(lineChart({series, xLabel: "N", yLabel: "r", logX: true, logY: false}))), 0)
})
