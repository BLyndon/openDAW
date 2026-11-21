// Drives the seven steps of the browser run in their fixed order and renders each step's results.
import {CONSUMERS, consumerLoad, REGION_COUNTS, budgetReport} from "../budget.mjs"
import {cell, sizeTable, stepTable} from "../markdown.mjs"
import {CI_TARGET} from "../stats.mjs"
import {barChart, lineChart} from "./charts.mjs"
import {batchNsFor, browserName, evaluateEnvironment, stepOutcome} from "./checks.mjs"
import {buildReport, reportFileName} from "./report.mjs"
import {createSequence, STEPS} from "./sequence.mjs"

const SIZES = [256, 512, 1024, 2048, 4096, 8192, 16384]
const NUMBERS = ["①", "②", "③", "④", "⑤", "⑥", "⑦"]
const OUTCOME = {ok: "✔ as expected", warn: "⚠ done, with remarks", fail: "✘ failed", running: "running…", ready: "", locked: ""}
const sequence = createSequence()
const browser = browserName(navigator.userAgent)
const worker = new Worker(new URL("./worker.mjs", import.meta.url), {type: "module"})
const pending = new Map()
let nextRequest = 0
let wasHidden = false

worker.onmessage = ({data: {id, result, error}}) => {
    const {resolve, reject} = pending.get(id)
    pending.delete(id)
    error === undefined ? resolve(result) : reject(new Error(error))
}
const request = (type, payload = {}) => new Promise((resolve, reject) => {
    const id = nextRequest++
    pending.set(id, {resolve, reject})
    worker.postMessage({id, type, ...payload})
})
document.addEventListener("visibilitychange", () => wasHidden ||= document.hidden)

const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const key = (name, n) => `${name}/${n}`
const options = () => sequence.data("module").options
const slot = (option) => option.option + 1
const batchNs = () => sequence.data("environment").batchNs

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

const sections = new Map(STEPS.map((step, index) => {
    const section = document.createElement("section")
    section.innerHTML = `<div class="step-head"><h2>${NUMBERS[index]} ${escape(step.title)}</h2><button>Run</button></div>`
        + `<p class="purpose">${escape(step.purpose)}</p><p class="expected"><strong>Expected:</strong> ${escape(step.expected)}</p>`
        + `<div class="outcome"></div><div class="results"></div>`
    section.querySelector("button").addEventListener("click", () => run(step.id))
    document.getElementById("steps").append(section)
    return [step.id, section]
}))

const render = () => {
    for (const {id} of STEPS) {
        const section = sections.get(id)
        const state = sequence.state(id)
        section.classList.toggle("locked", state === "locked")
        const button = section.querySelector("button")
        button.disabled = !sequence.canRun(id)
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
        section.querySelectorAll(".results button").forEach((rerun) => { rerun.disabled = !sequence.canRun(id) })
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
    area.innerHTML = markdownToHtml(sizeTable(title, SIZES, options(), (result) => cell(result?.[direction]), results))
        + (unsure.length === 0 ? "" : `<p>Rerun single points: ${unsure.map((result) =>
            `${escape(result.name)} N = ${result.n}<button class="small" data-name="${escape(result.name)}" data-n="${result.n}">rerun</button>`).join(" · ")}</p>`)
        + lineChart({series, xLabel: "N", yLabel: "µs per call", logX: true, logY: true})
    area.querySelectorAll("button[data-name]").forEach((button) => button.addEventListener("click", () =>
        rerunPoint(direction, options().find((option) => option.name === button.dataset.name), Number(button.dataset.n))))
}

const throughputOutcome = (direction, data) => ({...stepOutcome(Object.values(data), {wasHidden}), data})

const rerunPoint = async (direction, option, n) => {
    sequence.start(direction)
    wasHidden = document.hidden
    render()
    progress(direction, 0, 1)
    const measure = await request("throughput", {option: option.option, n, direction, batchNs: batchNs()})
    sequence.replacePoint(direction, key(option.name, n), measure)
    sequence.finish(direction, throughputOutcome(direction, sequence.data(direction)))
    renderThroughput(direction)
    render()
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
        const host = await fetch("/environment").then((response) => response.ok ? response.json() : undefined)
        const checks = await request("environment")
        const evaluated = evaluateEnvironment(checks)
        const reasons = [...evaluated.reasons, ...host === undefined ? ["the /environment endpoint is missing: serve the page with `node web/serve.mjs`"] : []]
        document.getElementById("environment").textContent = [`${browser.name} ${browser.version}`, host?.cpu, host?.os,
            `git ${host?.git ?? "unknown"}`, `timer tick ${(checks.tickNs / 1000).toFixed(1)} µs`].filter((part) => part !== undefined).join(" · ")
        sections.get("environment").querySelector(".results").innerHTML = markdownToHtml(["| Check | Value |", "|---|---|",
            `| cross-origin isolated | ${checks.isolated ? "yes" : "no"} |`, `| timer tick | ${(checks.tickNs / 1000).toFixed(1)} µs |`,
            `| SIMD128 | ${checks.simd ? "yes" : "no"} |`, `| batch length | ${(batchNsFor(checks.tickNs) / 1e6).toFixed(0)} ms |`])
        return {status: reasons.length === 0 ? "ok" : "fail", reasons, data: {...checks, host, batchNs: batchNsFor(checks.tickNs)}}
    },
    module: async () => {
        const loaded = await request("load", {url: "/fft_bench.wasm"})
        const stale = sequence.data("environment").host.moduleStale
        document.getElementById("environment").textContent += ` · module ${loaded.sha256}`
        sections.get("module").querySelector(".results").innerHTML = markdownToHtml(["| Option | Registry slot | Complex |", "|---|---|---|",
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
        const markdown = buildReport({environment: environmentRows(), options: options(), sizes: SIZES,
            results: SIZES.flatMap((n) => options().map((option) => ({name: option.name, n, forward: sequence.data("forward")[key(option.name, n)],
                inverse: sequence.data("inverse")[key(option.name, n)]}))), steps: stepEntries()})
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
        sections.get("steps").querySelector(".results").innerHTML = entries.length === 0 ? "<p>No option splits its transform into steps.</p>"
            : markdownToHtml(stepTable(entries.map((entry) => ({...entry, steps: entry.steps.map((step) => step.median)}))))
    },
    budget: () => {
        const loads = (consumer) => options().map((option) => ({name: option.name, slot: slot(option), load: consumerLoad(consumer, option, times)}))
        const stretch = CONSUMERS.find((consumer) => consumer.split)
        sections.get("budget").querySelector(".results").innerHTML = barChart({unit: " %", yLabel: "% of the render quantum, average",
            groups: CONSUMERS.map((consumer) => ({name: consumer.name, bars: loads(consumer).map(({name, slot: barSlot, load}) =>
                ({name, slot: barSlot, value: load === undefined ? undefined : load.average * 100}))}))})
            + `<h4>${escape(stretch.name)}: by number of regions</h4>`
            + barChart({unit: " %", yLabel: "% of the render quantum, average", groups: REGION_COUNTS.map((count) => ({
                name: `${count} region${count === 1 ? "" : "s"}`, bars: loads(stretch).map(({name, slot: barSlot, load}) =>
                    ({name, slot: barSlot, value: load === undefined ? undefined : load.average * 100 * count}))}))})
            + markdownToHtml(budgetReport(options(), times))
    }
}

const run = async (id) => {
    sequence.start(id)
    wasHidden = document.hidden
    render()
    const outcome = await steps[id]().catch((error) => ({status: "fail", reasons: [error.message], data: undefined}))
    sequence.finish(id, outcome)
    if (outcome.status !== "fail") {
        renderResults[id]?.()
    }
    render()
}

render()
