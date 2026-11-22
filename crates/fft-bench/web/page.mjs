// Drives the seven steps of the browser run in their fixed order and renders each step's results.
import {CONSUMERS, consumerLoad, REGION_COUNTS, budgetReport} from "../budget.mjs"
import {cell, sizeTable, stepTable} from "../markdown.mjs"
import {CI_TARGET} from "../stats.mjs"
import {barChart, lineChart} from "./charts.mjs"
import {batchNsFor, browserName, evaluateEnvironment, fetchHost, headerLine, stepOutcome} from "./checks.mjs"
import {createClient} from "./client.mjs"
import {GLOSSARY, HINTS, INTRO, QUESTION} from "./copy.mjs"
import {KERNEL, LIBRARY, LIBRARY_LIMIT, overviewHtml, overviewMarkdown, overviewRows} from "./overview.mjs"
import {buildReport, reportFileName} from "./report.mjs"
import {createSequence, runAll, runStep, STEPS} from "./sequence.mjs"

const SIZES = [256, 512, 1024, 2048, 4096, 8192, 16384]
const NUMBERS = ["①", "②", "③", "④", "⑤", "⑥", "⑦"]
const OUTCOME = {ok: "✔ as expected", warn: "⚠ done, with remarks", fail: "✘ failed", running: "running…", ready: "", locked: ""}
const sequence = createSequence()
const browser = browserName(navigator.userAgent)
const request = createClient(new Worker(new URL("./worker.mjs", import.meta.url), {type: "module"}))
let wasHidden = false
let runningAll = false
let facts = undefined
let factsMissing = false
document.addEventListener("visibilitychange", () => wasHidden ||= document.hidden)

const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const key = (name, n) => `${name}/${n}`
const options = () => sequence.data("module").options
const slot = (option) => option.option + 1
const batchNs = () => sequence.data("environment").batchNs
const hint = (text) => `<p class="hint">ⓘ ${escape(text)}</p>`

// Renders the Markdown this harness writes (headings, tables, paragraphs) so the page shows what the report says.
const markdownToHtml = (lines) => {
    const html = []
    let table = []
    const flush = () => {
        if (table.length > 0) {
            const rows = table.filter((row) => !/^\|[-|]+\|$/.test(row)).map((row) => row.slice(1, -1).split(" | ").map((value) => value.trim()))
            html.push(`<table><tr>${rows[0].map((value) => `<th>${escape(value)}</th>`).join("")}</tr>`
                + rows.slice(1).map((row) => `<tr>${row.map((value) => `<td>${escape(value)}</td>`).join("")}</tr>`).join("") + "</table>")
            table = []
        }
    }
    for (const line of lines) {
        if (line.startsWith("|")) {
            table.push(line)
            continue
        }
        flush()
        if (line.startsWith("#")) {
            html.push(`<h4>${escape(line.replace(/^#+ /, ""))}</h4>`)
        } else if (line.trim() !== "") {
            html.push(`<p>${escape(line)}</p>`)
        }
    }
    flush()
    return html.join("")
}

const withCode = (text) => escape(text).replace(/`([^`]+)`/g, "<code>$1</code>")
document.getElementById("question").innerHTML = QUESTION.map((line) => `<p>${escape(line)}</p>`).join("")
document.getElementById("intro").innerHTML = INTRO.map(([label, lines]) =>
    `<dt>${escape(label)}</dt><dd>${lines.map((line) => `<div>${withCode(line)}</div>`).join("")}</dd>`).join("")
document.getElementById("glossary").innerHTML = GLOSSARY.map(([term, explanation]) => `<dt>${escape(term)}</dt><dd>${escape(explanation)}</dd>`).join("")
document.getElementById("overview-hint").innerHTML = hint(HINTS.overview)
document.getElementById("steps").replaceChildren()
const sections = new Map(STEPS.map((step, index) => {
    const section = document.createElement("section")
    section.innerHTML = `<div class="step-head"><h2>${NUMBERS[index]} ${escape(step.title)}</h2><button>Run</button></div>`
        + [["What", step.what], ["Why", step.why], ["How", step.how], ["Expected", step.expected]]
            .map(([label, text]) => `<p class="explain"><strong>${label}:</strong> ${escape(text)}</p>`).join("")
        + `<div class="outcome"></div><div class="results"></div>`
    section.querySelector("button").addEventListener("click", () => run(step.id))
    document.getElementById("steps").append(section)
    return [step.id, section]
}))

const runAllButton = document.getElementById("run-all")
runAllButton.addEventListener("click", async () => {
    runningAll = true
    render()
    await runAll(sequence, (id) => run(id))
    runningAll = false
    render()
})

const overviewTimes = (name, n) => {
    const [forward, inverse] = ["forward", "inverse"].map((direction) => sequence.data(direction)?.[key(name, n)]?.median)
    return forward === undefined && inverse === undefined ? undefined : {forward, inverse}
}

const currentOverview = () => overviewRows({facts, factsMissing, times: overviewTimes, options: sequence.data("module")?.options ?? [], sizes: SIZES})

const renderOverview = () => {
    document.getElementById("overview").innerHTML = overviewHtml(currentOverview())
}

const render = () => {
    renderOverview()
    runAllButton.disabled = runningAll || !sequence.canRun(STEPS[0].id)
    runAllButton.textContent = runningAll ? "Running all…" : "Run all"
    for (const {id} of STEPS) {
        const section = sections.get(id)
        const state = sequence.state(id)
        section.classList.toggle("locked", state === "locked")
        const button = section.querySelector("button")
        button.disabled = runningAll || !sequence.canRun(id)
        button.textContent = ["ok", "warn", "fail"].includes(state) ? "Run again" : "Run"
        const outcome = section.querySelector(".outcome")
        outcome.className = `outcome ${state}`
        const reasons = sequence.reasons(id)
        if (state !== "running") {
            outcome.innerHTML = escape(OUTCOME[state]) + (reasons.length === 0 ? "" : `<ul>${reasons.map((reason) => `<li>${escape(reason)}</li>`).join("")}</ul>`)
        }
        if (state === "locked" || state === "ready") {
            section.querySelector(".results").innerHTML = ""
        }
        section.querySelectorAll(".results button").forEach((rerun) => { rerun.disabled = runningAll || !sequence.canRun(id) })
    }
}

const progress = (id, done, total) => {
    sections.get(id).querySelector(".outcome").textContent = `running… ${done} / ${total}`
}

const measureAll = async (id, measureOne) => {
    const points = SIZES.flatMap((n) => options().map((option) => ({option, n})))
    const data = {}
    for (const [index, {option, n}] of points.entries()) {
        progress(id, index, points.length)
        data[key(option.name, n)] = await measureOne(option, n)
    }
    return data
}

const throughputResults = (direction) => {
    const data = sequence.data(direction)
    return SIZES.flatMap((n) => options().map((option) => ({name: option.name, n, [direction]: data[key(option.name, n)]})))
}

const renderThroughput = (direction) => {
    const results = throughputResults(direction)
    const title = `${direction === "forward" ? "Forward" : "Inverse"}, throughput (µs)`
    const microseconds = (option, n) => sequence.data(direction)[key(option.name, n)]?.median / 1000
    const series = options().map((option) => ({name: option.name, slot: slot(option),
        points: SIZES.map((n) => [n, sequence.data(direction)[key(option.name, n)] === undefined ? undefined : microseconds(option, n)])}))
        .filter(({points}) => points.some(([, value]) => value !== undefined))
    const unsure = results.filter((result) => result[direction] !== undefined && result[direction].ci > CI_TARGET)
    const area = sections.get(direction).querySelector(".results")
    area.innerHTML = hint(HINTS.throughputTable) + markdownToHtml(sizeTable(title, SIZES, options(), (result) => cell(result?.[direction]), results))
        + (unsure.length === 0 ? "" : `<p>Rerun single points: ${unsure.map((result) =>
            `${escape(result.name)} N = ${result.n}<button class="small" data-name="${escape(result.name)}" data-n="${result.n}">rerun</button>`).join(" · ")}</p>`)
        + hint(HINTS.throughputChart) + lineChart({series, xLabel: "N", yLabel: "µs per call", logX: true, logY: true})
        + libraryRule(direction)
    area.querySelectorAll("button[data-name]").forEach((button) => button.addEventListener("click", () =>
        rerunPoint(direction, options().find((option) => option.name === button.dataset.name), Number(button.dataset.n))))
}

const libraryRule = (direction) => {
    const median = (name, n) => sequence.data(direction)[key(name, n)]?.median
    const ratios = (name) => SIZES.map((n) => [n, median(LIBRARY, n) === undefined || median(name, n) === undefined ? undefined
        : median(LIBRARY, n) / median(name, n)])
    const series = options().filter((option) => option.name !== LIBRARY)
        .map((option) => ({name: option.name, slot: slot(option), points: ratios(option.name)}))
        .filter(({points}) => points.some(([, ratio]) => ratio !== undefined))
    if (series.length === 0) {
        return ""
    }
    return `<h4>${LIBRARY} against every option: the 20 % rule</h4>` + hint(HINTS.libraryChart)
        + `<p>The decision overview at the top reads off ${LIBRARY} ÷ ${KERNEL}.</p>`
        + lineChart({series, xLabel: "N", yLabel: `${LIBRARY} time ÷ option time`, logX: true, logY: false,
            reference: {value: LIBRARY_LIMIT, label: "20 % limit: library preferred below"}})
}

const throughputOutcome = (direction, data, previous = []) => ({...stepOutcome(Object.values(data), {wasHidden, previous}), data})

const rerunPoint = (direction, option, n) => {
    const previous = sequence.reasons(direction)
    return run(direction, async () => {
        progress(direction, 0, 1)
        const measure = await request("throughput", {option: option.option, n, direction, batchNs: batchNs()})
        sequence.replacePoint(direction, key(option.name, n), measure)
        return throughputOutcome(direction, sequence.data(direction), previous)
    })
}

const times = (name, n) => {
    const forward = sequence.data("forward")[key(name, n)]
    return forward === undefined ? undefined : {forward: forward.median, inverse: sequence.data("inverse")[key(name, n)]?.median}
}

const stepEntries = () => Object.entries(sequence.data("steps")).filter(([, steps]) => steps.length > 0)
    .map(([entryKey, steps]) => ({name: entryKey.split("/")[0], n: Number(entryKey.split("/")[1]), steps}))

const environmentRows = () => {
    const {host, tickNs} = sequence.data("environment")
    const {bytes, sha256} = sequence.data("module")
    return [["date", new Date().toISOString().replace(/:\d\d\.\d+Z$/, " UTC").replace("T", " ")], ["cpu", host.cpu], ["arch", host.arch],
        ["os", host.os], ["runtime", `${browser.name} ${browser.version}`], ["isolated", "yes"], ["timer tick", `${(tickNs / 1000).toFixed(1)} µs`],
        ["batch length", `${(batchNs() / 1e6).toFixed(0)} ms`], ["module", `${host.module} (${bytes} bytes, sha256 ${sha256})`], ["git", host.git]]
}

const steps = {
    environment: async () => {
        const checks = await request("environment")
        const host = await fetchHost()
        const evaluated = evaluateEnvironment(checks)
        const reasons = [...evaluated.reasons, ...host === undefined ? ["the /environment endpoint is missing: serve the page with `node web/serve.mjs`"] : []]
        document.getElementById("environment").textContent = headerLine({browser, host, tickNs: checks.tickNs})
        sections.get("environment").querySelector(".results").innerHTML = hint(HINTS.environmentTable) + markdownToHtml(["| Check | Value |", "|---|---|",
            `| cross-origin isolated | ${checks.isolated ? "yes" : "no"} |`, `| timer tick | ${(checks.tickNs / 1000).toFixed(1)} µs |`,
            `| SIMD128 | ${checks.simd ? "yes" : "no"} |`, `| batch length | ${(batchNsFor(checks.tickNs) / 1e6).toFixed(0)} ms |`])
        return {status: reasons.length === 0 ? "ok" : "fail", reasons, data: {...checks, host, batchNs: batchNsFor(checks.tickNs)}}
    },
    module: async () => {
        const loaded = await request("load", {url: "/fft_bench.wasm"})
        const stale = (await fetchHost())?.moduleStale === true
        const {host, tickNs} = sequence.data("environment")
        document.getElementById("environment").textContent = headerLine({browser, host, tickNs, sha256: loaded.sha256})
        sections.get("module").querySelector(".results").innerHTML = hint(HINTS.moduleTable) + markdownToHtml(["| Option | Registry slot | Complex |", "|---|---|---|",
            ...loaded.options.map((option) => `| ${option.name} | ${option.option} | ${option.complex ? "yes" : "no"} |`)])
            + `<p>${loaded.bytes} bytes, sha256 ${escape(loaded.sha256)}</p>`
        return {status: stale ? "warn" : "ok", data: loaded,
            reasons: stale ? ["module older than its sources: rebuild with `cargo build --release --target wasm32-unknown-unknown`"] : []}
    },
    forward: async () => throughputOutcome("forward", await measureAll("forward", (option, n) =>
        request("throughput", {option: option.option, n, direction: "forward", batchNs: batchNs()}))),
    inverse: async () => throughputOutcome("inverse", await measureAll("inverse", (option, n) =>
        request("throughput", {option: option.option, n, direction: "inverse", batchNs: batchNs()}))),
    steps: async () => {
        const data = await measureAll("steps", (option, n) => request("steps", {option: option.option, n, batchNs: batchNs()}))
        const largest = Object.values(data).filter((entry) => entry.length > 0)
            .map((entry) => entry.reduce((top, step) => step.median > top.median ? step : top))
        return {...stepOutcome(largest, {wasHidden}), data}
    },
    budget: async () => ({status: "ok", reasons: [], data: {}}),
    report: async () => {
        const remarks = STEPS.filter(({id}) => sequence.state(id) === "warn")
            .flatMap(({id, title}) => sequence.reasons(id).map((reason) => `${title}: ${reason}`))
        const markdown = buildReport({environment: environmentRows(), options: options(), sizes: SIZES, remarks,
            results: SIZES.flatMap((n) => options().map((option) => ({name: option.name, n, forward: sequence.data("forward")[key(option.name, n)],
                inverse: sequence.data("inverse")[key(option.name, n)]}))), steps: stepEntries(), overview: overviewMarkdown(currentOverview())})
        const link = document.createElement("a")
        link.href = URL.createObjectURL(new Blob([markdown], {type: "text/markdown"}))
        link.download = reportFileName(browser)
        link.click()
        sections.get("report").querySelector(".results").innerHTML = `<p>Downloaded ${escape(link.download)}.</p>`
            + `<details><summary>Show the report</summary><pre>${escape(markdown)}</pre></details>`
        return {status: "ok", reasons: [], data: {markdown}}
    }
}

const renderResults = {
    forward: () => renderThroughput("forward"),
    inverse: () => renderThroughput("inverse"),
    steps: () => {
        const entries = stepEntries()
        const largest = (entry) => entry.steps.reduce((top, step) => step.median > top.median ? step : top)
        const flagged = entries.filter((entry) => largest(entry).ci > CI_TARGET)
        sections.get("steps").querySelector(".results").innerHTML = entries.length === 0 ? "<p>No option splits its transform into steps.</p>"
            : hint(HINTS.stepsTable) + markdownToHtml(stepTable(entries.map((entry) => ({...entry, steps: entry.steps.map((step) => step.median)}))))
            + (flagged.length === 0 ? "" : `<p>Largest step with a CI above ${CI_TARGET * 100} % (run the step again): ${flagged.map((entry) =>
                `${escape(entry.name)} N = ${entry.n} (±${(largest(entry).ci * 100).toFixed(1)} %)`).join(" · ")}</p>`)
    },
    budget: () => {
        const loads = (consumer) => options().map((option) => ({name: option.name, slot: slot(option), load: consumerLoad(consumer, option, times)}))
        const stretch = CONSUMERS.find((consumer) => consumer.split)
        sections.get("budget").querySelector(".results").innerHTML = hint(HINTS.budgetChart) + barChart({unit: " %", yLabel: "% of the render quantum, average",
            groups: CONSUMERS.map((consumer) => ({name: consumer.name, bars: loads(consumer).map(({name, slot: barSlot, load}) =>
                ({name, slot: barSlot, value: load === undefined ? undefined : load.average * 100}))}))})
            + `<h4>${escape(stretch.name)}: by number of regions</h4>`
            + barChart({unit: " %", yLabel: "% of the render quantum, average", groups: REGION_COUNTS.map((count) => ({
                name: `${count} region${count === 1 ? "" : "s"}`, bars: loads(stretch).map(({name, slot: barSlot, load}) =>
                    ({name, slot: barSlot, value: load === undefined ? undefined : load.average * 100 * count}))}))})
            + hint(HINTS.budgetTable) + markdownToHtml(budgetReport(options(), times))
    }
}

const run = async (id, work = steps[id]) => {
    wasHidden = document.hidden
    const finished = runStep(sequence, id, work)
    render()
    const outcome = await finished
    if (outcome.status !== "fail") {
        renderResults[id]?.()
    }
    render()
}

const loadFacts = async () => {
    const response = await fetch("/web/facts.json").catch(() => undefined)
    facts = response?.ok ? await response.json().catch(() => undefined) : undefined
    factsMissing = facts === undefined
    document.getElementById("facts-stale").classList.toggle("hidden", (await fetchHost().catch(() => undefined))?.factsStale !== true || factsMissing)
    render()
}

render()
loadFacts()
