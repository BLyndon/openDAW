// The decision overview: the plan's criteria against this run's timings and the repository's facts file. Pure functions,
// shared by the page and the report. States facts and thresholds only; it never ranks the options.
import {CONSUMERS, consumerLoad} from "../budget.mjs"
import {microseconds} from "../markdown.mjs"

export const LIBRARY = "realfft"
export const KERNEL = "simd"
// simd with the outlook items O1 and O4 (docs/simd-outlook.md), shown beside it.
export const SELECTION = "simd-o1o4"
export const REFERENCE = "rfft"
export const COLUMNS = [LIBRARY, KERNEL, SELECTION, REFERENCE]
// future-plans/simd-fft.md: prefer the library if it is within ~20 % of the hand-written kernel.
export const LIBRARY_LIMIT = 1.2
export const SPEED_TARGET = 4
export const SPEED_SIZES = [1024, 2048, 4096, 8192, 16384]
export const TIME_SIZES = [1024, 4096]
export const STRETCH_VOICES = 16
export const FACTS_MISSING = "facts file missing: run node facts.mjs"
// Ratios computed from equal times can land a rounding step above the limit.
const RATIO_TOLERANCE = 1e-9
const MARKS = {pass: "✔ ", fail: "✘ ", info: "", pending: "", missing: ""}

const cell = (text, status = "info") => ({text, status})
const empty = cell("–")
const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value)
const isCheck = (check) => isObject(check) && typeof check.worst === "number" && typeof check.pass === "boolean"
// A facts file from another schema counts as missing rather than breaking the page.
const usableFacts = (facts) => isObject(facts) && isObject(facts.options) && isObject(facts.generated)
    && typeof facts.generated.git === "string" && typeof facts.generated.date === "string"
const allColumns = (make) => Object.fromEntries(COLUMNS.map((name) => [name, make(name)]))

const timingRows = ({times, options, sizes}) => {
    const ran = (field) => options.some((option) => sizes.some((n) => times(option.name, n)?.[field] !== undefined))
    const pending = (field) => cell(field === "forward" ? "run step ③" : "run step ④", "pending")
    const timeCell = (field) => (name) => {
        const values = TIME_SIZES.map((n) => times(name, n)?.[field])
        return !ran(field) ? pending(field) : values.some((value) => value === undefined) ? empty
            : cell(`${values.map(microseconds).join(" / ")} µs`)
    }
    const speedUp = (name) => {
        if (!ran("forward")) {
            return pending("forward")
        }
        if (name === REFERENCE) {
            return cell("1×")
        }
        const ratios = SPEED_SIZES.map((n) => times(REFERENCE, n)?.forward / times(name, n)?.forward)
        if (ratios.some((ratio) => !Number.isFinite(ratio))) {
            return empty
        }
        const lowest = Math.min(...ratios)
        return cell(`${lowest.toFixed(1)}× (lowest of N = ${SPEED_SIZES.join(", ")})`, lowest >= SPEED_TARGET ? "pass" : "fail")
    }
    const libraryRule = () => {
        if (!ran("forward")) {
            return pending("forward")
        }
        const perSize = sizes.map((n) => {
            const ratios = ["forward", "inverse"].map((field) => times(LIBRARY, n)?.[field] / times(KERNEL, n)?.[field])
                .filter(Number.isFinite)
            return {n, ratios}
        }).filter(({ratios}) => ratios.length > 0)
        if (perSize.length === 0) {
            return empty
        }
        const all = perSize.flatMap(({ratios}) => ratios)
        const within = perSize.filter(({ratios}) => Math.max(...ratios) <= LIBRARY_LIMIT + RATIO_TOLERANCE).map(({n}) => n)
        const directions = ran("inverse") ? "forward and inverse" : "forward only"
        return cell(`${LIBRARY} ÷ ${KERNEL} = ${Math.min(...all).toFixed(2)}–${Math.max(...all).toFixed(2)} (${directions}); `
            + (within.length === 0 ? "outside at all sizes" : `within 20 % at N = ${within.join(", ")}`))
    }
    const stretch = CONSUMERS.find((consumer) => consumer.split)
    const budget = (name) => {
        if (!ran("forward") || !ran("inverse")) {
            return pending(ran("forward") ? "inverse" : "forward")
        }
        const option = options.find((entry) => entry.name === name)
        const load = option === undefined ? undefined : consumerLoad(stretch, option, times)
        return load === undefined ? empty : cell(`${(load.average * STRETCH_VOICES * 100).toFixed(1)} %`)
    }
    return [
        {criterion: `Forward time, N = ${TIME_SIZES.join(" / ")}`, threshold: {text: "–", kind: "none"}, cells: allColumns(timeCell("forward")),
            source: "step ③"},
        {criterion: `Inverse time, N = ${TIME_SIZES.join(" / ")}`, threshold: {text: "–", kind: "none"}, cells: allColumns(timeCell("inverse")),
            source: "step ④"},
        {criterion: `Speed-up vs. ${REFERENCE}, N = ${SPEED_SIZES[0]}–${SPEED_SIZES.at(-1)}`,
            threshold: {text: `≥ ${SPEED_TARGET}×`, kind: "proposal"}, cells: allColumns(speedUp), source: "step ③"},
        {criterion: `20 % rule: ${LIBRARY} ÷ ${KERNEL}`, threshold: {text: `≤ ${LIBRARY_LIMIT} → prefer the library, if it passes all gates`, kind: "plan"},
            cells: {[LIBRARY]: libraryRule(), [KERNEL]: cell(""), [SELECTION]: cell(""), [REFERENCE]: cell("")}, source: "steps ③ and ④"},
        {criterion: `Time-stretch budget, ${STRETCH_VOICES} regions`, threshold: {text: "≤ P % of a render quantum", kind: "open"},
            cells: allColumns(budget), source: "step ⑥ model, steps ③ and ④ times"}
    ]
}

const factsRows = ({facts, factsMissing}) => {
    const missing = factsMissing || !usableFacts(facts)
    const fromFacts = (valid, make) => allColumns((name) => {
        if (missing) {
            return cell(FACTS_MISSING, "missing")
        }
        const entry = facts.options[name]
        return isObject(entry) && valid(entry) ? make(entry) : empty
    })
    const validAccuracy = ({accuracy}) => isObject(accuracy) && isCheck(accuracy.rms) && isCheck(accuracy.contract)
        && (accuracy.roundTrip === null || isCheck(accuracy.roundTrip))
    const accuracy = ({accuracy: {rms, roundTrip, contract}}) => {
        const failing = [["rel. RMS", rms], ["round trip", roundTrip], ["contract", contract]]
            .filter(([, check]) => check !== null && !check.pass).map(([name]) => name)
        return failing.length === 0 ? cell(`pass (worst rel. RMS ${rms.worst.toExponential(1)})`, "pass")
            : cell(`fails ${failing.join(", ")}`, "fail")
    }
    const source = missing ? "facts file missing" : `facts (git ${facts.generated.git}, ${facts.generated.date})`
    return [
        {criterion: "Accuracy gates", threshold: {text: "rel. RMS ≤ 2× rfft, round trip < 1e-5, contract ≤ 1e-5", kind: "plan"},
            cells: fromFacts(validAccuracy, accuracy), source},
        {criterion: "Allocation after plan creation", threshold: {text: "none", kind: "plan"},
            cells: fromFacts(({allocations}) => Number.isInteger(allocations), ({allocations}) => cell(`${allocations}`, allocations === 0 ? "pass" : "fail")), source},
        {criterion: "Wasm size added (wasm-opt + gzip)", threshold: {text: "≤ S kB", kind: "open"},
            cells: fromFacts(({size}) => isObject(size) && typeof size.gzipAdded === "number", ({size}) => cell(`${(size.gzipAdded / 1000).toFixed(1)} kB`)), source},
        {criterion: "Links no_std with the engine's allocator", threshold: {text: "required", kind: "plan"},
            cells: fromFacts(({noStd}) => typeof noStd === "boolean", ({noStd}) => noStd ? cell("yes", "pass") : cell("no", "fail")), source},
        {criterion: "Dependencies · licence", threshold: {text: "–", kind: "none"},
            cells: fromFacts(({licence}) => typeof licence === "string",
                ({size, licence}) => cell(`${isObject(size) && Number.isInteger(size.crates) ? `${size.crates} crates in the build` : "–"} · ${licence}`)), source}
    ]
}

// `times(name, n)` returns {forward, inverse} in ns per call or undefined; `options` as the module lists them.
export const overviewRows = ({facts, factsMissing, times, options, sizes}) =>
    [...timingRows({times, options, sizes}), ...factsRows({facts, factsMissing})]

const thresholdText = ({text, kind}) => kind === "none" ? text : `${text} (${kind})`
const header = ["Criterion", LIBRARY, KERNEL, SELECTION, `${REFERENCE} (today)`, "Threshold", "Source"]

export const overviewHtml = (rows) => `<table class="overview"><tr>${header.map((title) => `<th>${escape(title)}</th>`).join("")}</tr>`
    + rows.map((row) => `<tr><td>${escape(row.criterion)}</td>`
        + COLUMNS.map((name) => `<td class="${row.cells[name].status}">${MARKS[row.cells[name].status]}${escape(row.cells[name].text)}</td>`).join("")
        + `<td class="threshold ${row.threshold.kind}">${escape(thresholdText(row.threshold))}</td><td class="source">${escape(row.source)}</td></tr>`)
        .join("") + "</table>"

export const overviewMarkdown = (rows) => [
    `| ${header.join(" | ")} |`,
    `|${"---|".repeat(header.length)}`,
    ...rows.map((row) => `| ${[row.criterion, ...COLUMNS.map((name) => `${MARKS[row.cells[name].status]}${row.cells[name].text}`),
        thresholdText(row.threshold), row.source].join(" | ")} |`)]
