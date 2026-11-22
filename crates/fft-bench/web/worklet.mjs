// Drives the worklet page: the same options timed in a Worker and in an AudioWorklet, offline and in real time.
import {cell, environmentTable, microseconds} from "../markdown.mjs"
import {CI_TARGET, ciHalfWidth, median, percentile} from "../stats.mjs"
import {batchNsFor, browserName, fetchHost, fetchModuleBytes, headerLine, measureTick, simdSupported, stepOutcome, TICK_LIMIT_NS} from "./checks.mjs"
import {lineChart} from "./charts.mjs"
import {createClient} from "./client.mjs"
import {createSequence, runAll, runStep} from "./sequence.mjs"
import {DIRECTIONS, pairDifferences, RENDER_QUANTUM, STATUS, totalBlocks, WORKLET_OPTIONS, WORKLET_SIZES} from "./worklet-logic.mjs"
import {GLOSSARY, HINTS, INTRO, QUESTION, STEPS} from "./worklet-copy.mjs"

export const MIN_CORES = 4
export const ROUNDS = 6
export const PAIRS = 20
export const SAMPLE_RATE = 48000
const STALL_MS = 5000
// Share of counted pairs that may be dropped before the step shows a remark.
export const DROP_LIMIT = 0.01
const POLL_MS = 200
// Rendering may start before the processor exists; the extra quanta make sure every scheduled block runs.
const SPARE_BLOCKS = 256
const NUMBERS = ["①", "②", "③", "④", "⑤", "⑥", "⑦"]
const OUTCOME = {ok: "✔ as expected", warn: "⚠ done, with remarks", fail: "✘ failed", running: "running…", ready: "", locked: ""}
const REBUILD = "cargo build --release --target wasm32-unknown-unknown"

export const key = (name, n, direction) => `${name}/${n}/${direction}`

// Every option, size and direction the Worker could time; an option without an inverse has no inverse jobs.
export const buildJobs = (options, workerData) => DIRECTIONS.flatMap((direction) => WORKLET_SIZES.flatMap((n) => options
    .filter(({name}) => WORKLET_OPTIONS.includes(name) && workerData[key(name, n, direction)] !== undefined)
    .map(({option, name}) => ({option, name, n, direction}))))

export const summarize = ({differences, dropped}) => differences.length === 0 ? {median: NaN, ci: Infinity, p99: NaN, batches: 0, dropped}
    : {median: median(differences), ci: ciHalfWidth(differences), p99: percentile(differences, 0.99), batches: differences.length, dropped}

// Per job: the worklet's records turned into a measure, keyed like the Worker data.
export const summarizeRun = (jobs, records, counts, shape) => Object.fromEntries(jobs.map((job, index) =>
    [key(job.name, job.n, job.direction), summarize(pairDifferences(records, counts, index, shape))]))

export const compareBits = (worker, worklet) => {
    const expected = new Map(worker.map(({name, n, signal, hash}) => [`${name}/${n}/${signal}`, hash]))
    const mismatches = worklet.filter(({name, n, signal, hash}) => expected.get(`${name}/${n}/${signal}`) !== hash)
    return {cases: worklet.length, missing: Math.max(0, worker.length - worklet.length), mismatches}
}

export const ratio = (worklet, worker) => {
    if (worklet === undefined || worker === undefined || !Number.isFinite(worklet.median)) {
        return undefined
    }
    const value = worklet.median / worker.median
    return {value, same: Math.abs(value - 1) <= worklet.ci + worker.ci}
}

export const ratioCell = (worklet, worker) => {
    const result = ratio(worklet, worker)
    return result === undefined ? "–" : `${result.value.toFixed(2)} ${result.same ? "same" : "differs"}`
}

// realfft time ÷ the own kernel's time, per size; undefined where either is missing.
export const ranking = (data, direction, kernel = "simd-o1o4") => WORKLET_SIZES.map((n) => {
    const library = data?.[key("realfft", n, direction)]?.median
    const own = data?.[key(kernel, n, direction)]?.median
    return [n, library === undefined || own === undefined || !Number.isFinite(own) ? undefined : library / own]
})

// Ratio charts start here, so a few per cent are visible; a lower value widens the axis.
const RATIO_AXIS_MIN = 0.8
const RUNS = [["worker", "Worker"], ["offline", "offline"], ["realtime", "real time"]]
const directionLabel = (direction) => direction === "forward" ? "forward" : "inverse"

// One line per option: worklet time ÷ Worker time over N; 1 means the audio thread costs the same.
export const ratioSeries = (data, run, direction) => WORKLET_OPTIONS.map((name, index) => ({name, slot: index + 1,
    points: WORKLET_SIZES.map((n) => [n, ratio(data[run]?.[key(name, n, direction)], data.worker?.[key(name, n, direction)])?.value])}))

// One line per option: real-time p99 ÷ median over N; 1 means no slow tail.
export const tailSeries = (data, direction) => WORKLET_OPTIONS.map((name, index) => ({name, slot: index + 1,
    points: WORKLET_SIZES.map((n) => {
        const measure = data.realtime?.[key(name, n, direction)]
        return [n, measure === undefined || !Number.isFinite(measure.p99) ? undefined : measure.p99 / measure.median]
    })}))

// One line per run and direction: realfft ÷ simd-o1o4 over N, against the plan's 20 % rule.
export const rankingSeries = (data) => DIRECTIONS.flatMap((direction, directionIndex) => RUNS.map(([run, label], runIndex) =>
    ({name: `${directionLabel(direction)} · ${label}`, slot: directionIndex * RUNS.length + runIndex + 1, points: ranking(data[run], direction)})))

const hasPoints = (series) => series.some(({points}) => points.some(([, value]) => value !== undefined))

export const ratioCharts = (data, run) => DIRECTIONS.map((direction) => {
    const series = ratioSeries(data, run, direction)
    return hasPoints(series) ? `<h4>${directionLabel(direction)}: ${run === "offline" ? "offline" : "real time"} ÷ Worker</h4>`
        + lineChart({series, xLabel: "N", yLabel: "worklet time ÷ Worker time", logX: true, logY: false, reference: {value: 1, label: "same as Worker"},
            yMin: RATIO_AXIS_MIN})
        : ""
}).join("")

const p99Cell = (measure) => measure === undefined || !Number.isFinite(measure.p99) ? "–" : microseconds(measure.p99)
const rankingCell = (value) => value === undefined ? "–" : `${value.toFixed(2)}${value <= 1.2 ? " ≤ 1.2" : ""}`

export const timeRows = (jobs, {worker, offline, realtime}) => jobs.map(({name, n, direction}) => {
    const id = key(name, n, direction)
    return [name, String(n), cell(worker?.[id]), cell(offline?.[id]), ratioCell(offline?.[id], worker?.[id]), cell(realtime?.[id]),
        p99Cell(realtime?.[id]), ratioCell(realtime?.[id], worker?.[id]),
        String((offline?.[id]?.dropped ?? 0) + (realtime?.[id]?.dropped ?? 0))]
})

const TIME_HEAD = ["Option", "N", "Worker", "Offline", "÷ Worker", "Real time", "p99", "÷ Worker", "Dropped"]

export const buildWorkletReport = ({environment, jobs, data, bits, underruns, remarks = []}) => {
    const table = (head, rows) => [`| ${head.join(" | ")} |`, `|${"---|".repeat(head.length)}`, ...rows.map((row) => `| ${row.join(" | ")} |`)]
    return [...environmentTable(environment), "",
        ...remarks.length === 0 ? [] : ["## Remarks", "", ...remarks.map((remark) => `- ⚠ ${remark}`), ""],
        "## Same bits on the audio thread", "",
        bits === undefined ? "Not checked." : `${bits.cases - bits.mismatches.length} of ${bits.cases} cases identical to the Worker.`, "",
        "## Time per call (µs)", "",
        `Median with the 95 % CI half-width; ⚠ marks a CI above ${CI_TARGET * 100} %. "÷ Worker" is the worklet time divided by the `
        + "Worker time; \"same\" if within both CIs.", "",
        ...DIRECTIONS.flatMap((direction) => [`### ${direction === "forward" ? "Forward" : "Inverse"}`, "",
            ...table(TIME_HEAD, timeRows(jobs.filter((job) => job.direction === direction), data)), ""]),
        "## realfft ÷ simd-o1o4", "",
        ...table(["Direction", "Run", ...WORKLET_SIZES.map((n) => `N = ${n}`)], DIRECTIONS.flatMap((direction) =>
            ["worker", "offline", "realtime"].map((run) => [direction, run, ...ranking(data[run], direction).map(([, value]) => rankingCell(value))]))), "",
        `Underruns during the real-time run: ${underruns ?? "not reported by this browser"}`].join("\n")
}

// The run's wall time against the audio time it rendered; a hidden or throttled tab renders far slower.
export const SLOW_LIMIT = 1.5
export const slowRemark = (blocks, seconds, sampleRate = SAMPLE_RATE) => {
    const audioSeconds = blocks * RENDER_QUANTUM / sampleRate
    return seconds <= SLOW_LIMIT * audioSeconds ? [] : [`${blocks} quanta (${audioSeconds.toFixed(1)} s of audio) took `
        + `${seconds.toFixed(1)} s: the audio thread did not run in real time (tab hidden or audio throttled); the numbers are not valid`]
}

export const droppedRemark = (dropped, counted) =>
    dropped <= DROP_LIMIT * counted ? [] : [`${dropped} of ${counted} pairs dropped (clock descheduled), above ${DROP_LIMIT * 100} %`]

export const reportFileName = ({name, version}) => `worklet-${name.toLowerCase()}-${version.split(".")[0]}.md`

// Underrun count from Chrome's AudioContext.playbackStats; undefined elsewhere.
export const underrunEvents = (context) => {
    const stats = context.playbackStats
    return stats === undefined || typeof stats.underrunEvents !== "number" ? undefined : stats.underrunEvents
}

const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const withCode = (text) => escape(text).replace(/`([^`]+)`/g, "<code>$1</code>")
const hint = (text) => `<p class="hint">ⓘ ${escape(text)}</p>`
const htmlTable = (head, rows) => `<table><tr>${head.map((value) => `<th>${escape(value)}</th>`).join("")}</tr>`
    + rows.map((row) => `<tr>${row.map((value) => `<td>${escape(value)}</td>`).join("")}</tr>`).join("") + "</table>"

const waitFor = (port, type) => new Promise((resolve) => {
    const listener = ({data}) => {
        if (data.type === type) {
            port.removeEventListener("message", listener)
            resolve(data)
        }
    }
    port.addEventListener("message", listener)
    port.start()
})

const start = () => {
    const sequence = createSequence(STEPS)
    const browser = browserName(navigator.userAgent)
    const request = createClient(new Worker(new URL("./worker.mjs", import.meta.url), {type: "module"}))
    const clockMemory = new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT)
    const clock = new Float64Array(clockMemory)
    const registered = new WeakSet()
    let clockWorker
    let realtimeContext
    let wasHidden = false
    let runningAll = false
    document.addEventListener("visibilitychange", () => wasHidden ||= document.hidden)
    window.addEventListener("pagehide", () => clockWorker?.terminate())
    // Created on the first click, so the browser lets it start later without a new gesture.
    const ensureRealtimeContext = () => {
        realtimeContext ??= new AudioContext({sampleRate: SAMPLE_RATE, latencyHint: "interactive"})
        realtimeContext.suspend()
    }

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
        section.querySelector("button").addEventListener("click", () => {
            ensureRealtimeContext()
            run(step.id)
        })
        document.getElementById("steps").append(section)
        return [step.id, section]
    }))

    const runAllButton = document.getElementById("run-all")
    runAllButton.addEventListener("click", async () => {
        ensureRealtimeContext()
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
        }
    }

    const progress = (id, done, total) => {
        sections.get(id).querySelector(".outcome").textContent = `running… ${done} / ${total}`
    }

    const module = () => sequence.data("module")
    const jobs = () => buildJobs(module().options, sequence.data("worker"))
    const shape = () => ({jobCount: jobs().length, rounds: ROUNDS, pairs: PAIRS})

    // Adds the processor to `context` and builds a node; a browser that cannot send a Module gets the bytes.
    const createNode = async (context, options, {compiled, bytes} = module()) => {
        if (!registered.has(context)) {
            await context.audioWorklet.addModule(new URL("./worklet-processor.mjs", import.meta.url))
            registered.add(context)
        }
        const build = (payload) => new AudioWorkletNode(context, "fft-bench",
            {numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: {...options, ...payload}})
        const create = () => {
            const node = build({module: compiled})
            return {node, transfer: "module"}
        }
        const created = await Promise.resolve().then(create).catch(() => ({node: build({bytes}), transfer: "bytes"}))
        const failure = new Promise((_, reject) => created.node.addEventListener("processorerror",
            () => reject(new Error("the worklet processor failed: see the browser console"))))
        return {...created, failure}
    }

    const timingMemory = () => {
        const {jobCount, rounds, pairs} = shape()
        const control = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT)
        const counts = new SharedArrayBuffer(rounds * jobCount * Float64Array.BYTES_PER_ELEMENT)
        const records = new SharedArrayBuffer(rounds * jobCount * pairs * 2 * Float64Array.BYTES_PER_ELEMENT)
        new Float64Array(records).fill(NaN)
        return {control, counts, records}
    }

    const timingOptions = (memory) => ({mode: "timing", clock: clockMemory, ...memory,
        jobs: jobs().map(({option, n, direction}) => ({option, n, direction})), shape: shape()})

    const finishTiming = (memory) => {
        const control = new Int32Array(memory.control)
        if (Atomics.load(control, 1) !== STATUS.done) {
            throw new Error(`the worklet stopped after ${Atomics.load(control, 0)} of ${totalBlocks(shape())} blocks`)
        }
        const data = summarizeRun(jobs(), new Float64Array(memory.records), new Float64Array(memory.counts), shape())
        const dropped = Object.values(data).reduce((sum, measure) => sum + measure.dropped, 0)
        const outcome = stepOutcome(Object.values(data), {wasHidden})
        const counted = Object.values(data).reduce((sum, measure) => sum + measure.batches + measure.dropped, 0)
        const reasons = [...outcome.reasons, ...droppedRemark(dropped, counted)]
        return {status: reasons.length === 0 ? "ok" : "warn", reasons, data}
    }

    const steps = {
        environment: async () => {
            clockWorker ??= new Worker(new URL("./clock.mjs", import.meta.url))
            const cores = navigator.hardwareConcurrency
            if (cores >= MIN_CORES) {
                clockWorker.postMessage(clockMemory)
            }
            const checks = await request("environment")
            const host = await fetchHost()
            await new Promise((resolve) => setTimeout(resolve, 100))
            const clockTickNs = measureTick(() => clock[0] * 1e6)
            const reasons = [
                ...checks.isolated ? [] : ["the page is not cross-origin isolated: serve it with `node web/serve.mjs`"],
                ...cores >= MIN_CORES ? [] : [`${cores} logical cores: the clock Worker would compete with the audio thread (needs ${MIN_CORES})`],
                ...checks.simd && simdSupported() ? [] : ["WebAssembly SIMD128 is not available"],
                ...clockTickNs <= TICK_LIMIT_NS ? [] : [`the shared clock ticks in ${(clockTickNs / 1000).toFixed(0)} µs steps, above ${TICK_LIMIT_NS / 1000} µs`],
                ...host === undefined ? ["the /environment endpoint is missing: serve the page with `node web/serve.mjs`"] : []]
            document.getElementById("environment").textContent = headerLine({browser, host, tickNs: clockTickNs})
            sections.get("environment").querySelector(".results").innerHTML = hint(HINTS.environmentTable) + htmlTable(["Check", "Value"],
                [["cross-origin isolated", checks.isolated ? "yes" : "no"], ["logical cores", String(cores)], ["SIMD128", checks.simd ? "yes" : "no"],
                    ["Worker timer tick", `${(checks.tickNs / 1000).toFixed(1)} µs`], ["shared clock tick", `${(clockTickNs / 1000).toFixed(1)} µs`]])
            return {status: reasons.length === 0 ? "ok" : "fail", reasons,
                data: {...checks, host, clockTickNs, cores, batchNs: batchNsFor(checks.tickNs)}}
        },
        module: async () => {
            const loaded = await request("load", {url: "/fft_bench.wasm"})
            const bytes = await fetchModuleBytes((target) => fetch(target), "/fft_bench.wasm")
            const compiled = await WebAssembly.compile(bytes)
            const context = new OfflineAudioContext({numberOfChannels: 1, length: RENDER_QUANTUM, sampleRate: SAMPLE_RATE})
            const {node, transfer, failure} = await createNode(context, {mode: "bits"}, {compiled, bytes})
            const [worklet, bits] = await Promise.race([Promise.all([waitFor(node.port, "loaded"), waitFor(node.port, "bits"),
                context.startRendering()]), failure])
            const missing = loaded.options.map(({name}) => name).filter((name) => !worklet.options.includes(name))
            const stale = (await fetchHost())?.moduleStale === true
            const reasons = [...missing.length === 0 ? [] : [`options missing in the worklet: ${missing.join(", ")}`],
                ...worklet.simd ? [] : ["SIMD128 is not available in the worklet"],
                ...stale ? [`module older than its sources: rebuild with \`${REBUILD}\``] : []]
            const {host, clockTickNs} = sequence.data("environment")
            document.getElementById("environment").textContent = headerLine({browser, host, tickNs: clockTickNs, sha256: loaded.sha256})
            sections.get("module").querySelector(".results").innerHTML = htmlTable(["Check", "Value"],
                [["options (Worker)", loaded.options.map(({name}) => name).join(", ")], ["options (worklet)", worklet.options.join(", ")],
                    ["SIMD128 in the worklet", worklet.simd ? "yes" : "no"], ["sent to the worklet as", transfer],
                    ["module", `${loaded.bytes} bytes, sha256 ${loaded.sha256}`]])
            const failed = missing.length > 0 || !worklet.simd
            return {status: failed ? "fail" : stale ? "warn" : "ok", reasons,
                data: {...loaded, bytes, compiled, transfer, workletBits: bits.cases}}
        },
        bits: async () => {
            const worker = await request("digests")
            const result = compareBits(worker, module().workletBits)
            const reasons = [...result.mismatches.length === 0 ? [] : [`${result.mismatches.length} of ${result.cases} cases differ`],
                ...result.missing === 0 ? [] : [`${result.missing} cases missing in the worklet`]]
            sections.get("bits").querySelector(".results").innerHTML = hint(HINTS.bitsTable) + htmlTable(["Option", "N", "Signal", "Worker = worklet"],
                result.mismatches.slice(0, 20).map(({name, n, signal}) => [name, String(n), String(signal), "no"]))
                + `<p>${result.cases - result.mismatches.length} of ${result.cases} cases identical.</p>`
            return {status: reasons.length === 0 ? "ok" : "fail", reasons, data: result}
        },
        worker: async () => {
            const points = DIRECTIONS.flatMap((direction) => WORKLET_SIZES.flatMap((n) => module().options
                .filter(({name}) => WORKLET_OPTIONS.includes(name)).map((option) => ({...option, n, direction}))))
            const data = {}
            for (const [index, {option, name, n, direction}] of points.entries()) {
                progress("worker", index, points.length)
                const measure = await request("throughput", {option, n, direction, batchNs: sequence.data("environment").batchNs})
                if (measure !== undefined) {
                    data[key(name, n, direction)] = measure
                }
            }
            return {...stepOutcome(Object.values(data), {wasHidden}), data}
        },
        offline: async () => {
            const memory = timingMemory()
            const total = totalBlocks(shape())
            const context = new OfflineAudioContext({numberOfChannels: 1, length: (total + SPARE_BLOCKS) * RENDER_QUANTUM, sampleRate: SAMPLE_RATE})
            const {node, failure} = await createNode(context, timingOptions(memory))
            node.connect(context.destination)
            const control = new Int32Array(memory.control)
            const timer = setInterval(() => progress("offline", Atomics.load(control, 0), total), POLL_MS)
            await Promise.race([context.startRendering(), failure]).finally(() => clearInterval(timer))
            return finishTiming(memory)
        },
        realtime: async () => {
            const memory = timingMemory()
            const total = totalBlocks(shape())
            const context = realtimeContext
            const {node, failure} = await createNode(context, timingOptions(memory))
            const control = new Int32Array(memory.control)
            const before = underrunEvents(context)
            node.connect(context.destination)
            await context.resume()
            const startedMs = performance.now()
            const finished = new Promise((resolve, reject) => {
                let last = -1
                let lastChange = Date.now()
                const timer = setInterval(() => {
                    const done = Atomics.load(control, 0)
                    progress("realtime", done, total)
                    if (done !== last) {
                        last = done
                        lastChange = Date.now()
                    }
                    if (Atomics.load(control, 1) === STATUS.done) {
                        clearInterval(timer)
                        resolve()
                    } else if (Date.now() - lastChange > STALL_MS) {
                        clearInterval(timer)
                        reject(new Error(`no progress for ${STALL_MS / 1000} s (context state: ${context.state}); `
                            + "the browser may need a click on the page to start audio"))
                    }
                }, POLL_MS)
            })
            await Promise.race([finished, failure]).finally(() => {
                node.disconnect()
                return context.suspend()
            })
            const after = underrunEvents(context)
            const underruns = before === undefined || after === undefined ? undefined : after - before
            const outcome = finishTiming(memory)
            const slow = slowRemark(total, (performance.now() - startedMs) / 1000)
            const reasons = [...outcome.reasons, ...slow, ...underruns === undefined || underruns === 0 ? [] : [`${underruns} underruns`]]
            const status = slow.length > 0 ? "fail" : reasons.length === 0 ? outcome.status : "warn"
            return {status, reasons, data: outcome.data, underruns}
        },
        report: async () => {
            const remarks = STEPS.filter(({id}) => sequence.state(id) === "warn")
                .flatMap(({id, title}) => sequence.reasons(id).map((reason) => `${title}: ${reason}`))
            const markdown = buildWorkletReport({environment: environmentRows(), jobs: jobs(), data: allData(), bits: sequence.data("bits"),
                underruns: realtimeUnderruns, remarks})
            const link = document.createElement("a")
            link.href = URL.createObjectURL(new Blob([markdown], {type: "text/markdown"}))
            link.download = reportFileName(browser)
            link.click()
            sections.get("report").querySelector(".results").innerHTML = `<p>Downloaded ${escape(link.download)}.</p>`
                + `<details><summary>Show the report</summary><pre>${escape(markdown)}</pre></details>`
            return {status: "ok", reasons: [], data: {markdown}}
        }
    }

    let realtimeUnderruns
    const allData = () => ({worker: sequence.data("worker"), offline: sequence.data("offline"), realtime: sequence.data("realtime")})

    const environmentRows = () => {
        const {host, clockTickNs, cores} = sequence.data("environment")
        const {bytes, sha256, transfer} = module()
        return [["date", new Date().toISOString().replace(/:\d\d\.\d+Z$/, " UTC").replace("T", " ")], ["cpu", host.cpu], ["arch", host.arch],
            ["os", host.os], ["logical cores", String(cores)], ["runtime", `${browser.name} ${browser.version}`], ["isolated", "yes"],
            ["shared clock tick", `${(clockTickNs / 1000).toFixed(1)} µs`], ["sample rate", `${SAMPLE_RATE} Hz`],
            ["schedule", `${ROUNDS} rounds (first not counted) × ${PAIRS} pairs per option and size`],
            ["module", `${host.module} (${bytes.byteLength} bytes, sha256 ${sha256}, sent as ${transfer})`], ["git", host.git]]
    }

    const renderTimes = () => {
        const area = sections.get("realtime").querySelector(".results")
        const data = allData()
        area.innerHTML = hint(HINTS.ratioChart) + ratioCharts(data, "realtime")
            + `<h4>Slow tail in real time: p99 ÷ median</h4>` + hint(HINTS.tailChart)
            + DIRECTIONS.map((direction) => lineChart({series: tailSeries(data, direction), xLabel: `N (${directionLabel(direction)})`,
                yLabel: "p99 ÷ median", logX: true, logY: true})).join("")
            + `<h4>realfft ÷ simd-o1o4</h4>` + hint(HINTS.ranking)
            + lineChart({series: rankingSeries(data), xLabel: "N", yLabel: "realfft time ÷ simd-o1o4 time", logX: true, logY: false,
                reference: {value: 1.2, label: "20 % rule"}, yMin: 1})
            + `<details><summary>Tables</summary>` + hint(HINTS.timeTable)
            + DIRECTIONS.map((direction) => `<h4>${direction === "forward" ? "Forward" : "Inverse"}: µs per call</h4>`
                + htmlTable(TIME_HEAD, timeRows(jobs().filter((job) => job.direction === direction), data))).join("")
            + htmlTable(["Direction", "Run", ...WORKLET_SIZES.map((n) => `N = ${n}`)], DIRECTIONS.flatMap((direction) =>
                ["worker", "offline", "realtime"].map((run) => [direction, run, ...ranking(data[run], direction).map(([, value]) => rankingCell(value))])))
            + `</details>`
    }

    const renderOffline = () => {
        const data = allData()
        sections.get("offline").querySelector(".results").innerHTML = hint(HINTS.ratioChart) + ratioCharts(data, "offline")
            + `<details><summary>Tables</summary>` + hint(HINTS.timeTable) + DIRECTIONS.map((direction) =>
                `<h4>${direction === "forward" ? "Forward" : "Inverse"}: µs per call</h4>`
                + htmlTable(TIME_HEAD, timeRows(jobs().filter((job) => job.direction === direction), data))).join("") + `</details>`
    }

    const renderResults = {offline: renderOffline, realtime: renderTimes}

    const run = async (id, work = steps[id]) => {
        wasHidden = document.hidden
        const finished = runStep(sequence, id, async () => {
            const outcome = await work()
            if (id === "realtime") {
                realtimeUnderruns = outcome.underruns
            }
            return outcome
        })
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
