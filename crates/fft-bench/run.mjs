// Node runner for the wasm build of fft-bench: times every option at every size and prints Markdown.
// Build first: cargo build --release --target wasm32-unknown-unknown   (SIMD128 via .cargo/config.toml)
// Usage: node run.mjs [module.wasm] [--sizes 1024,4096] [--options rfft,realfft]
import fs from "node:fs"
import os from "node:os"
import crypto from "node:crypto"
import {execFileSync} from "node:child_process"
import {budgetReport, RENDER_QUANTUM_NS} from "./budget.mjs"
import {listOptions} from "./measure.mjs"
import {cell, environmentTable, microseconds, sizeTable, stepTable} from "./markdown.mjs"
import {CI_TARGET, MAX_BATCHES, median, percentile, throughput, WARM_UP_CALLS} from "./stats.mjs"

const DEFAULT_MODULE = "target/wasm32-unknown-unknown/release/fft_bench.wasm"
const SIZES = [256, 512, 1024, 2048, 4096, 8192, 16384]
const SINGLE_CALLS = 2000
const STEP_REPETITIONS = 500
const BATCH_NS = 10e6

const argument = (name) => {
    const index = process.argv.indexOf(name)
    return index > 0 ? process.argv[index + 1] : undefined
}
const modulePath = process.argv[2] !== undefined && !process.argv[2].startsWith("--") ? process.argv[2] : DEFAULT_MODULE
const sizes = argument("--sizes")?.split(",").map(Number) ?? SIZES
const optionFilter = argument("--options")?.split(",")

const bytes = fs.readFileSync(modulePath)
const {instance} = await WebAssembly.instantiate(bytes, {})
const wasm = instance.exports
const options = listOptions(wasm).filter(({name}) => optionFilter === undefined || optionFilter.includes(name))

const now = () => Number(process.hrtime.bigint())
// The cost of one timer pair around an empty call; included in every single-call value below.
const timerOverhead = () => {
    const samples = Array.from({length: SINGLE_CALLS}, () => {
        const start = now()
        return now() - start
    })
    return median(samples)
}

// Per-call timing of the kernel alone; `prepare` runs before every call, untimed.
const singleCall = (prepare, kernel) => {
    for (let call = 0; call < WARM_UP_CALLS; call++) {
        prepare()
        kernel()
    }
    const samples = Array.from({length: SINGLE_CALLS}, () => {
        prepare()
        const start = now()
        kernel()
        return now() - start
    })
    return {median: median(samples), p99: percentile(samples, 0.99)}
}

// Time of each forward step of a stage-wise option, one step per call, as its consumer runs them.
const stepTimes = (steps) => {
    const samples = Array.from({length: steps}, () => [])
    for (let repetition = 0; repetition < WARM_UP_CALLS + STEP_REPETITIONS; repetition++) {
        wasm.prepare_forward()
        for (let step = 0; step < steps; step++) {
            const start = now()
            wasm.run_step(step)
            const elapsed = now() - start
            if (repetition >= WARM_UP_CALLS) {
                samples[step].push(elapsed)
            }
        }
    }
    return samples.map(median)
}

const git = (...gitArguments) => {
    try {
        return execFileSync("git", gitArguments, {encoding: "utf8"}).trim()
    } catch {
        return "unknown"
    }
}

const environment = [
    ["date", new Date().toISOString().replace(/:\d\d\.\d+Z$/, " UTC").replace("T", " ")],
    ["cpu", os.cpus()[0]?.model ?? "unknown"],
    ["arch", os.arch()],
    ["os", `${os.type()} ${os.release()}`],
    ["runtime", `Node ${process.version}, V8 ${process.versions.v8}`],
    ["module", `${modulePath} (${bytes.length} bytes, sha256 ${crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12)})`],
    ["git", `${git("rev-parse", "--short", "HEAD")}${git("status", "--porcelain", "--untracked-files=no") === "" ? "" : "-dirty"}`],
    ["timer pair", `${timerOverhead().toFixed(0)} ns`]
]

const results = []
for (const n of sizes) {
    for (const {option, name} of options) {
        wasm.setup(option, n)
        const result = {name, n}
        result.forward = throughput(wasm.run_forward, now, BATCH_NS)
        result.forwardCall = singleCall(wasm.prepare_forward, wasm.forward_kernel)
        if (wasm.has_inverse() === 1) {
            result.inverse = throughput(wasm.run_inverse, now, BATCH_NS)
            result.inverseCall = singleCall(wasm.prepare_inverse, wasm.inverse_kernel)
        }
        const steps = wasm.steps()
        if (steps > 0) {
            result.steps = stepTimes(steps)
        }
        results.push(result)
        process.stderr.write(`${name} ${n} done\n`)
    }
}

const print = (lines) => lines.forEach((line) => console.log(line))
const table = (title, value) => print(sizeTable(title, sizes, options, value, results))
print(environmentTable(environment))
console.log("\n## Wasm timings (Node)\n")
console.log(`Throughput: median µs per call with the 95 % CI half-width; ⚠ marks a CI above ${CI_TARGET * 100} % after ${MAX_BATCHES} batches.\n`)
table("Forward, throughput (µs)", (result) => cell(result.forward))
table("Inverse, throughput (µs)", (result) => cell(result.inverse))
table("Forward, single call: median / p99 (µs, includes one timer pair)",
    (result) => `${microseconds(result.forwardCall.median)} / ${microseconds(result.forwardCall.p99)}`)
table("Forward, % of the 128-frame render quantum at 48 kHz",
    (result) => `${(result.forward.median / RENDER_QUANTUM_NS * 100).toFixed(2)} %`)
print(stepTable(results))

const times = (name, n) => {
    const result = results.find((entry) => entry.name === name && entry.n === n)
    return result === undefined ? undefined : {forward: result.forward.median, inverse: result.inverse?.median}
}
console.log()
print(budgetReport(options, times))
