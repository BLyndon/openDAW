// Drives the stages page: the outlook stages measured side by side, one chart line per size.
import {cell, environmentTable, sizeTable} from "../markdown.mjs"
import {CI_TARGET, MAX_BATCHES} from "../stats.mjs"
import {lineChart} from "./charts.mjs"
import {batchNsFor, browserName, evaluateEnvironment, fetchHost, headerLine, stepOutcome} from "./checks.mjs"
import {createClient} from "./client.mjs"
import {createSequence, runAll, runStep} from "./sequence.mjs"
import {GLOSSARY, HINTS, INTRO, QUESTION, STAGE_TEXT, STEPS} from "./stages-copy.mjs"

export const SIZES = [1024, 2048, 4096, 8192, 16384]
const NUMBERS = ["①", "②", "③", "④", "⑤"]
const OUTCOME = {ok: "✔ as expected", warn: "⚠ done, with remarks", fail: "✘ failed", running: "running…", ready: "", locked: ""}
const REBUILD = "cargo build --release --target wasm32-unknown-unknown"

export const key = (name, n) => `${name}/${n}`

// One series per size: [stage index, µs per transform] for every stage, undefined where unmeasured.
export const timeSeries = (stages, data) => SIZES.map((n, index) => ({name: `N = ${n}`, slot: index + 1,
    points: stages.map((stage, position) => [position, data[key(stage.name, n)] === undefined ? undefined : data[key(stage.name, n)].median / 1000])}))

// One series per size: S0's time divided by each stage's time.
export const speedupSeries = (stages, data) => SIZES.map((n, index) => {
    const base = data[key(stages[0].name, n)]?.median
    return {name: `N = ${n}`, slot: index + 1, points: stages.map((stage, position) => {
        const time = data[key(stage.name, n)]?.median
        return [position, base === undefined || time === undefined ? undefined : base / time]
    })}
})

export const buildStagesReport = ({environment, stages, forward, inverse, remarks = []}) => {
    const results = SIZES.flatMap((n) => stages.map(({name}) => ({name, n, forward: forward[key(name, n)], inverse: inverse?.[key(name, n)]})))
    const table = (title, value) => sizeTable(title, SIZES, stages, value, results)
    return [...environmentTable(environment), "",
        "## Stages", "", "| Stage | Item |", "|---|---|", ...stages.map(({name}) => `| ${name} | ${STAGE_TEXT[name] ?? ""} |`), "",
        ...remarks.length === 0 ? [] : ["## Remarks", "", ...remarks.map((remark) => `- ⚠ ${remark}`), ""],
        "## Wasm timings (browser)", "",
        `Median µs per transform with the 95 % CI half-width; ⚠ marks a CI above ${CI_TARGET * 100} % after ${MAX_BATCHES} batches.`, "",
        ...table("Forward (µs per transform)", (result) => cell(result?.forward)),
        ...table("Inverse (µs per transform)", (result) => cell(result?.inverse)),
        ...table("Forward speed-up against S0", (result) => speedup(result, forward, stages)),
        ...table("Inverse speed-up against S0", (result) => speedup(result, inverse, stages))].join("\n")
}

const speedup = (result, data, stages) => {
    const base = data?.[key(stages[0].name, result.n)]?.median
    const time = data?.[key(result.name, result.n)]?.median
    return base === undefined || time === undefined ? "–" : `${(base / time).toFixed(2)}×`
}

export const reportFileName = ({name, version}) => `stages-${name.toLowerCase()}-${version.split(".")[0]}.md`

const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const withCode = (text) => escape(text).replace(/`([^`]+)`/g, "<code>$1</code>")
const hint = (text) => `<p class="hint">ⓘ ${escape(text)}</p>`
const htmlTable = (head, rows) => `<table><tr>${head.map((value) => `<th>${escape(value)}</th>`).join("")}</tr>`
    + rows.map((row) => `<tr>${row.map((value) => `<td>${escape(value)}</td>`).join("")}</tr>`).join("") + "</table>"

const start = () => {
    const sequence = createSequence(STEPS)
    const browser = browserName(navigator.userAgent)
    const request = createClient(new Worker(new URL("./worker.mjs", import.meta.url), {type: "module"}))
    let wasHidden = false
    let runningAll = false
    document.addEventListener("visibilitychange", () => wasHidden ||= document.hidden)
    const stages = () => sequence.data("module").stages
    const batchNs = () => sequence.data("environment").batchNs
    const xTicks = () => stages().map((stage, position) => [position, stage.name])

    document.getElementById("question").innerHTML = QUESTION.map((line) => `<p>${escape(line)}</p>`).join("")
    document.getElementById("intro").innerHTML = INTRO.map(([label, lines]) =>
        `<dt>${escape(label)}</dt><dd>${lines.map((line) => `<div>${withCode(line)}</div>`).join("")}</dd>`).join("")
    document.getElementById("glossary").innerHTML = GLOSSARY.map(([term, explanation]) => `<dt>${escape(term)}</dt><dd>${escape(explanation)}</dd>`).join("")
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
        await runAll(sequence, (id) => run(id), STEPS)
        runningAll = false
        render()
    })

    const render = () => {
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

    const measure = (direction, stage, n) => request("stageThroughput", {stage: stage.stage, n, direction, batchNs: batchNs()})

    const measureAll = async (direction) => {
        const points = SIZES.flatMap((n) => stages().map((stage) => ({stage, n})))
        const data = {}
        for (const [index, {stage, n}] of points.entries()) {
            progress(direction, index, points.length)
            data[key(stage.name, n)] = await measure(direction, stage, n)
        }
        return {...stepOutcome(Object.values(data), {wasHidden}), data}
    }

    const rerunPoint = (direction, stage, n) => {
        const previous = sequence.reasons(direction)
        return run(direction, async () => {
            progress(direction, 0, 1)
            sequence.replacePoint(direction, key(stage.name, n), await measure(direction, stage, n))
            return {...stepOutcome(Object.values(sequence.data(direction)), {wasHidden, previous}), data: sequence.data(direction)}
        })
    }

    const renderDirection = (direction) => {
        const data = sequence.data(direction)
        const unsure = SIZES.flatMap((n) => stages().map((stage) => ({stage, n})))
            .filter(({stage, n}) => data[key(stage.name, n)] !== undefined && data[key(stage.name, n)].ci > CI_TARGET)
        const label = direction === "forward" ? "Forward" : "Inverse"
        const area = sections.get(direction).querySelector(".results")
        area.innerHTML = `<h4>${label}: µs per transform by stage</h4>` + hint(HINTS.timeChart)
            + lineChart({series: timeSeries(stages(), data), xLabel: "stage (items added left to right)", yLabel: "µs per transform",
                logX: false, logY: true, xTicks: xTicks()})
            + `<h4>${label}: speed-up against S0</h4>` + hint(HINTS.speedupChart)
            + lineChart({series: speedupSeries(stages(), data), xLabel: "stage (items added left to right)", yLabel: "S0 time ÷ stage time",
                logX: false, logY: false, xTicks: xTicks(), reference: {value: 1, label: "S0"}})
            + `<h4>${label}: table</h4>` + hint(HINTS.table)
            + htmlTable(["Stage", ...SIZES.map((n) => `N = ${n}`)], stages().map((stage) => [stage.name, ...SIZES.map((n) => cell(data[key(stage.name, n)]))]))
            + (unsure.length === 0 ? "" : `<p>Rerun single points: ${unsure.map(({stage, n}) =>
                `${escape(stage.name)} N = ${n}<button class="small" data-stage="${stage.stage}" data-n="${n}">rerun</button>`).join(" · ")}</p>`)
        area.querySelectorAll("button[data-stage]").forEach((button) => button.addEventListener("click", () =>
            rerunPoint(direction, stages()[Number(button.dataset.stage)], Number(button.dataset.n))))
    }

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
            sections.get("environment").querySelector(".results").innerHTML = hint(HINTS.environmentTable) + htmlTable(["Check", "Value"],
                [["cross-origin isolated", checks.isolated ? "yes" : "no"], ["timer tick", `${(checks.tickNs / 1000).toFixed(1)} µs`],
                    ["SIMD128", checks.simd ? "yes" : "no"], ["batch length", `${(batchNsFor(checks.tickNs) / 1e6).toFixed(0)} ms`]])
            return {status: reasons.length === 0 ? "ok" : "fail", reasons, data: {...checks, host, batchNs: batchNsFor(checks.tickNs)}}
        },
        module: async () => {
            const loaded = await request("load", {url: "/fft_bench.wasm"})
            if (loaded.stages.length === 0) {
                return {status: "fail", reasons: ["the module has no stages"], data: loaded}
            }
            const stale = (await fetchHost())?.moduleStale === true
            const {host, tickNs} = sequence.data("environment")
            document.getElementById("environment").textContent = headerLine({browser, host, tickNs, sha256: loaded.sha256})
            sections.get("module").querySelector(".results").innerHTML = hint(HINTS.moduleTable)
                + htmlTable(["Stage", "Transforms per call", "Item"], loaded.stages.map((stage) => [stage.name, String(stage.batch), STAGE_TEXT[stage.name] ?? ""]))
                + `<p>${loaded.bytes} bytes, sha256 ${escape(loaded.sha256)}</p>`
            return {status: stale ? "warn" : "ok", data: loaded, reasons: stale ? [`module older than its sources: rebuild with \`${REBUILD}\``] : []}
        },
        forward: () => measureAll("forward"),
        inverse: () => measureAll("inverse"),
        report: async () => {
            const remarks = STEPS.filter(({id}) => sequence.state(id) === "warn")
                .flatMap(({id, title}) => sequence.reasons(id).map((reason) => `${title}: ${reason}`))
            const markdown = buildStagesReport({environment: environmentRows(), stages: stages(), forward: sequence.data("forward"),
                inverse: sequence.data("inverse"), remarks})
            const link = document.createElement("a")
            link.href = URL.createObjectURL(new Blob([markdown], {type: "text/markdown"}))
            link.download = reportFileName(browser)
            link.click()
            sections.get("report").querySelector(".results").innerHTML = `<p>Downloaded ${escape(link.download)}.</p>`
                + `<details><summary>Show the report</summary><pre>${escape(markdown)}</pre></details>`
            return {status: "ok", reasons: [], data: {markdown}}
        }
    }

    const renderResults = {forward: () => renderDirection("forward"), inverse: () => renderDirection("inverse")}

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

    render()
}

if (typeof document !== "undefined") {
    start()
}
