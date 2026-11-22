// Checks of the worklet page's data shaping and report: node --test web/worklet.test.mjs
import {test} from "node:test"
import assert from "node:assert/strict"
import {buildJobs, buildWorkletReport, compareBits, droppedRemark, key, rankingSeries, ratioCharts, ratioSeries, slowRemark, tailSeries, ranking, ratio, ratioCell, reportFileName, summarize, summarizeRun,
    underrunEvents} from "./worklet.mjs"
import {recordIndex, WORKLET_OPTIONS, WORKLET_SIZES} from "./worklet-logic.mjs"
import {STEPS} from "./worklet-copy.mjs"

const OPTIONS = ["analyser", "rfft", "realfft", "simd", "simd-o1o4"].map((name, option) => ({option, name}))
const workerData = Object.fromEntries(WORKLET_OPTIONS.flatMap((name) => WORKLET_SIZES.flatMap((n) =>
    ["forward", ...name === "rfft" ? [] : ["inverse"]].map((direction) => [key(name, n, direction), {median: n, ci: 0.01, batches: 30}]))))

test("buildJobs: only the page's options, only where the Worker has a time", () => {
    const jobs = buildJobs(OPTIONS, workerData)
    assert.ok(jobs.every(({name}) => WORKLET_OPTIONS.includes(name)))
    assert.equal(jobs.length, WORKLET_SIZES.length * (2 * WORKLET_OPTIONS.length - 1))
    assert.ok(!jobs.some(({name, direction}) => name === "rfft" && direction === "inverse"))
    assert.deepEqual(jobs[0], {option: 1, name: "rfft", n: WORKLET_SIZES[0], direction: "forward"})
})

test("summarize: median, CI and p99 of the samples; no samples give NaN, not a throw", () => {
    const summary = summarize({differences: [1, 2, 3, 4, 100], dropped: 2})
    assert.equal(summary.median, 3)
    assert.equal(summary.p99, 100)
    assert.equal(summary.batches, 5)
    assert.equal(summary.dropped, 2)
    assert.ok(Number.isNaN(summarize({differences: [], dropped: 3}).median))
})

test("summarizeRun: one measure per job, keyed like the Worker data", () => {
    const jobs = [{option: 1, name: "rfft", n: 256, direction: "forward"}]
    const shape = {jobCount: 1, rounds: 2, pairs: 1}
    const records = new Float64Array(4).fill(NaN)
    records[recordIndex({round: 1, job: 0, pair: 0, withKernel: 0}, shape)] = 1000
    records[recordIndex({round: 1, job: 0, pair: 0, withKernel: 1}, shape)] = 3000
    const run = summarizeRun(jobs, records, new Float64Array([4, 4]), shape)
    assert.deepEqual(Object.keys(run), [key("rfft", 256, "forward")])
    assert.equal(run[key("rfft", 256, "forward")].median, 500)
})

test("compareBits: lists the cases whose hash differs and counts missing ones", () => {
    const worker = [{name: "simd", n: 256, signal: 0, hash: 1}, {name: "simd", n: 256, signal: 1, hash: 2}, {name: "simd", n: 256, signal: 2, hash: 3}]
    const worklet = [{name: "simd", n: 256, signal: 0, hash: 1}, {name: "simd", n: 256, signal: 1, hash: 9}]
    const result = compareBits(worker, worklet)
    assert.equal(result.cases, 2)
    assert.equal(result.missing, 1)
    assert.deepEqual(result.mismatches, [worklet[1]])
})

test("ratio: same when the deviation lies within both CIs", () => {
    assert.deepEqual(ratio({median: 103, ci: 0.02}, {median: 100, ci: 0.02}), {value: 1.03, same: true})
    assert.equal(ratio({median: 110, ci: 0.02}, {median: 100, ci: 0.02}).same, false)
    assert.equal(ratio(undefined, {median: 100, ci: 0.02}), undefined)
    assert.equal(ratio({median: NaN, ci: Infinity}, {median: 100, ci: 0.02}), undefined)
    assert.equal(ratioCell({median: 110, ci: 0.02}, {median: 100, ci: 0.02}), "1.10 differs")
})

test("ranking: realfft ÷ simd-o1o4 per size, undefined where one is missing", () => {
    const data = {[key("realfft", 1024, "forward")]: {median: 150}, [key("simd-o1o4", 1024, "forward")]: {median: 100}}
    const result = new Map(ranking(data, "forward"))
    assert.equal(result.get(1024), 1.5)
    assert.equal(result.get(256), undefined)
})

test("buildWorkletReport: environment, bits, one table per direction, the ranking and underruns", () => {
    const jobs = buildJobs(OPTIONS, workerData)
    const markdown = buildWorkletReport({environment: [["runtime", "Chrome 157"]], jobs, data: {worker: workerData, offline: workerData},
        bits: {cases: 4, mismatches: [], missing: 0}, underruns: 0, remarks: ["Worklet, real time: 1 underruns"]})
    for (const heading of ["## Environment", "## Remarks", "## Same bits on the audio thread", "### Forward", "### Inverse", "## realfft ÷ simd-o1o4"]) {
        assert.match(markdown, new RegExp(`^${heading}$`, "m"), heading)
    }
    assert.match(markdown, /4 of 4 cases identical/)
    assert.match(markdown, /\| simd \| 1024 \| 1\.02 ±1\.0 % \| 1\.02 ±1\.0 % \| 1\.00 same \|/)
    assert.match(markdown, /Underruns during the real-time run: 0/)
    assert.match(buildWorkletReport({environment: [], jobs: [], data: {}}), /not reported by this browser/)
})

test("underrunEvents: Chrome's playbackStats count, undefined without the API", () => {
    assert.equal(underrunEvents({playbackStats: {underrunEvents: 3}}), 3)
    assert.equal(underrunEvents({}), undefined)
})

test("reportFileName and step ids", () => {
    assert.equal(reportFileName({name: "Firefox", version: "157.0.1"}), "worklet-firefox-157.md")
    assert.deepEqual(STEPS.map(({id}) => id), ["environment", "module", "bits", "worker", "offline", "realtime", "report"])
})

test("droppedRemark: a few dropped pairs are normal, more than 1 % is a remark", () => {
    assert.deepEqual(droppedRemark(9, 3200), [])
    assert.deepEqual(droppedRemark(40, 3200), ["40 of 3200 pairs dropped (clock descheduled), above 1 %"])
})

test("slowRemark: a run in real time passes, a throttled one is flagged", () => {
    assert.deepEqual(slowRemark(8064, 22.5), [])
    assert.match(slowRemark(8064, 120)[0], /^8064 quanta \(21\.5 s of audio\) took 120\.0 s/)
})

test("ratioSeries: one line per option, worklet ÷ Worker per size, gaps where unmeasured", () => {
    const realtime = {[key("simd", 1024, "forward")]: {median: 1.8, ci: 0.01}}
    const worker = {[key("simd", 1024, "forward")]: {median: 2, ci: 0.01}}
    const series = ratioSeries({worker, realtime}, "realtime", "forward")
    assert.deepEqual(series.map(({name}) => name), WORKLET_OPTIONS)
    const simd = new Map(series.find(({name}) => name === "simd").points)
    assert.equal(simd.get(1024), 0.9)
    assert.equal(simd.get(256), undefined)
})

test("tailSeries: real-time p99 ÷ median per size", () => {
    const realtime = {[key("rfft", 4096, "inverse")]: {median: 30, p99: 60}}
    const points = new Map(tailSeries({realtime}, "inverse")[0].points)
    assert.equal(points.get(4096), 2)
    assert.equal(points.get(256), undefined)
})

test("rankingSeries: one line per direction and run, each with its own colour", () => {
    const series = rankingSeries({worker: {[key("realfft", 256, "forward")]: {median: 3}, [key("simd-o1o4", 256, "forward")]: {median: 2}}})
    assert.equal(series.length, 6)
    assert.deepEqual(series.map(({slot}) => slot), [1, 2, 3, 4, 5, 6])
    assert.equal(series[0].name, "forward · Worker")
    assert.equal(new Map(series[0].points).get(256), 1.5)
})

test("ratioCharts: one SVG per direction with data, nothing without", () => {
    const realtime = {[key("simd", 1024, "forward")]: {median: 1.8, ci: 0.01}}
    const worker = {[key("simd", 1024, "forward")]: {median: 2, ci: 0.01}}
    assert.equal((ratioCharts({worker, realtime}, "realtime").match(/<svg/g) ?? []).length, 1)
    assert.equal(ratioCharts({worker: {}, realtime: {}}, "realtime"), "")
})
