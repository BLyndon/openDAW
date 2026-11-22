// Checks of the decision overview: node --test web/overview.test.mjs
import {test} from "node:test"
import assert from "node:assert/strict"
import {LIBRARY_LIMIT, overviewHtml, overviewMarkdown, overviewRows} from "./overview.mjs"

const SIZES = [256, 512, 1024, 2048, 4096, 8192, 16384]
// Forward ns per call at N = 1024 and 4096 from the Node run; other sizes scaled by N·log2 N.
const NODE = {rfft: [7030, 32900], realfft: [1490, 8500], simd: [920, 5600], signalsmith: [12900, 61300]}
const scaled = ([at1024, at4096], n) => n <= 1024 ? at1024 * n * Math.log2(n) / 10240 : at4096 * n * Math.log2(n) / 49152
const timesFrom = (table, withInverse = true) => (name, n) => table[name] === undefined ? undefined
    : {forward: scaled(table[name], n), inverse: withInverse ? scaled(table[name], n) * 1.1 : undefined}
const OPTIONS = ["analyser", "rfft", "signalsmith", "reverted", "realfft", "simd", "simd-complex"]
    .map((name, option) => ({name, option, complex: ["analyser", "signalsmith", "reverted", "simd-complex"].includes(name)}))
const gates = (pass) => ({rms: {worst: 1.4e-7, gate: 2.4e-7, pass}, roundTrip: {worst: 9e-8, limit: 1e-5, pass: true},
    contract: {worst: 1.8e-7, limit: 1e-5, pass: true}})
const FACTS = {generated: {git: "abc1234", date: "2026-11-22", rustc: "rustc 1.93.0"}, options: {
    realfft: {accuracy: gates(true), allocations: 0, size: {gzipAdded: 172585, crates: 9}, noStd: false, licence: "realfft MIT · rustfft MIT OR Apache-2.0"},
    simd: {accuracy: gates(true), allocations: 0, size: {gzipAdded: 9454, crates: 3}, noStd: true, licence: "AGPL-3.0 (project)"},
    rfft: {accuracy: gates(true), allocations: 0, size: {gzipAdded: 4544, crates: 5}, noStd: true, licence: "AGPL-3.0 (project)"}}}
const INPUT = {facts: FACTS, factsMissing: false, times: timesFrom(NODE), options: OPTIONS, sizes: SIZES}
const rowFor = (rows, start) => rows.find((row) => row.criterion.startsWith(start))
const timesWithRatio = (ratio) => (name, n) => ({forward: name === "realfft" ? 1000 * ratio : 1000, inverse: name === "realfft" ? 1000 * ratio : 1000})
const nothingRun = () => undefined

test("speed-up row passes simd at ≥ 4× and labels the threshold a proposal", () => {
    const row = rowFor(overviewRows(INPUT), "Speed-up")
    assert.equal(row.cells.simd.status, "pass")
    assert.match(row.cells.simd.text, /^5\.9×/)
    assert.equal(row.cells.rfft.text, "1×")
    assert.equal(row.threshold.kind, "proposal")
})

test("20 % rule: a ratio of exactly 1.2 counts as within", () => {
    assert.equal(LIBRARY_LIMIT, 1.2)
    const row = rowFor(overviewRows({...INPUT, times: timesWithRatio(1.2)}), "20 %")
    assert.match(row.cells.realfft.text, /within 20 % at N = 256, 512, 1024/)
    assert.equal(row.threshold.kind, "plan")
})

test("20 % rule: the Node numbers lie outside at every size", () => {
    const row = rowFor(overviewRows(INPUT), "20 %")
    assert.match(row.cells.realfft.text, /outside at all sizes/)
})

test("before step ④ the inverse cells say which step to run", () => {
    const rows = overviewRows({...INPUT, times: timesFrom(NODE, false)})
    const row = rowFor(rows, "Inverse")
    assert.equal(row.cells.simd.status, "pending")
    assert.equal(row.cells.simd.text, "run step ④")
    assert.doesNotMatch(overviewHtml(rows), /NaN|undefined/)
})

test("before any step every browser cell is pending and the facts rows are already filled", () => {
    const rows = overviewRows({...INPUT, times: nothingRun})
    assert.equal(rowFor(rows, "Forward").cells.simd.text, "run step ③")
    assert.equal(rowFor(rows, "Wasm size").cells.simd.text, "9.5 kB")
    assert.doesNotMatch(overviewHtml(rows), /NaN|undefined/)
})

test("without a facts file the facts rows say how to produce it, and the page rows still work", () => {
    const rows = overviewRows({...INPUT, facts: undefined, factsMissing: true})
    assert.equal(rowFor(rows, "Links no_std").cells.simd.text, "facts file missing: run node facts.mjs")
    assert.equal(rowFor(rows, "Links no_std").cells.simd.status, "missing")
    assert.equal(rowFor(rows, "Forward").cells.simd.status, "info")
})

test("an option absent from facts shows – and does not throw", () => {
    const facts = {...FACTS, options: {realfft: FACTS.options.realfft}}
    assert.equal(rowFor(overviewRows({...INPUT, facts}), "Wasm size").cells.simd.text, "–")
})

test("failing gates and allocations are marked and named", () => {
    const facts = {...FACTS, options: {...FACTS.options, simd: {...FACTS.options.simd, accuracy: gates(false), allocations: 2}}}
    const rows = overviewRows({...INPUT, facts})
    assert.equal(rowFor(rows, "Accuracy").cells.simd.status, "fail")
    assert.match(rowFor(rows, "Accuracy").cells.simd.text, /rel\. RMS/)
    assert.equal(rowFor(rows, "Allocation").cells.simd.status, "fail")
})

test("no_std: realfft fails the required link, simd passes", () => {
    const row = rowFor(overviewRows(INPUT), "Links no_std")
    assert.equal(row.cells.realfft.status, "fail")
    assert.equal(row.cells.simd.status, "pass")
})

test("open thresholds carry no pass or fail mark", () => {
    const rows = overviewRows(INPUT)
    for (const start of ["Time-stretch", "Wasm size"]) {
        const row = rowFor(rows, start)
        assert.equal(row.threshold.kind, "open")
        assert.ok(Object.values(row.cells).every((cell) => !["pass", "fail"].includes(cell.status)), start)
    }
})

test("no row carries a recommendation or a total", () => {
    const html = overviewHtml(overviewRows(INPUT))
    assert.doesNotMatch(html, /recommend|winner|total/i)
})

test("overviewMarkdown has one line per row plus header and separator", () => {
    const rows = overviewRows(INPUT)
    assert.equal(overviewMarkdown(rows).filter((line) => line.startsWith("|")).length, rows.length + 2)
})

test("a facts file with the wrong shape counts as missing and never throws", () => {
    for (const facts of [null, {}, [], {options: {}}, {generated: {git: "x", date: "d"}, options: null}, "text"]) {
        const rows = overviewRows({...INPUT, facts, factsMissing: false})
        assert.equal(rowFor(rows, "Accuracy").cells.simd.text, "facts file missing: run node facts.mjs", JSON.stringify(facts))
        assert.doesNotMatch(overviewHtml(rows), /NaN|undefined/)
    }
})

test("an option entry from an older schema shows – instead of throwing", () => {
    const facts = {...FACTS, options: {...FACTS.options, simd: {size: 123}}}
    const rows = overviewRows({...INPUT, facts})
    for (const start of ["Accuracy", "Allocation", "Wasm size", "Links no_std", "Dependencies"]) {
        assert.equal(rowFor(rows, start).cells.simd.text, "–", start)
    }
})

test("the 20 % rule states the plan's full condition", () => {
    assert.match(rowFor(overviewRows(INPUT), "20 %").threshold.text, /if it passes all gates/)
})
