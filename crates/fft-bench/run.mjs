// Node runner for the wasm build of fft-bench: times every option at every size and prints Markdown.
// Build first: cargo build --release --target wasm32-unknown-unknown   (SIMD128 via .cargo/config.toml)
// Usage: node run.mjs [module.wasm] [--sizes 1024,4096] [--options rfft,realfft]
import fs from "node:fs"
import os from "node:os"
import crypto from "node:crypto"
import {execFileSync} from "node:child_process"

const DEFAULT_MODULE = "target/wasm32-unknown-unknown/release/fft_bench.wasm"
const SIZES = [256, 512, 1024, 2048, 4096, 8192, 16384]
const RENDER_QUANTUM_NS = 128 / 48000 * 1e9
const WARM_UP_CALLS = 200
const SINGLE_CALLS = 2000
const STEP_REPETITIONS = 500
const BATCH_NS = 10e6
const MIN_BATCHES = 30
const MAX_BATCHES = 120
const EXTRA_BATCHES = 10
const CI_TARGET = 0.05
const BOOTSTRAP_SAMPLES = 1000
const BOOTSTRAP_SEED = 0x12345678

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
const optionName = (option) => new TextDecoder().decode(
    new Uint8Array(wasm.memory.buffer, wasm.option_name_ptr(option), wasm.option_name_len(option)))
const options = Array.from({length: wasm.option_count()}, (_, option) => ({option, name: optionName(option)}))
    .filter(({name}) => optionFilter === undefined || optionFilter.includes(name))

const now = () => Number(process.hrtime.bigint())
const median = (values) => {
    const sorted = [...values].sort((left, right) => left - right)
    const middle = sorted.length >> 1
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const percentile = (values, fraction) => {
    const sorted = [...values].sort((left, right) => left - right)
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

// 95 % bootstrap confidence interval of the median, as a half-width relative to the median.
// Seeded xorshift32, so a rerun on the same data gives the same interval.
const ciHalfWidth = (values) => {
    let state = BOOTSTRAP_SEED
    const random = () => {
        state ^= state << 13
        state ^= state >>> 17
        state ^= state << 5
        return (state >>> 0) / 4294967296
    }
    const medians = Array.from({length: BOOTSTRAP_SAMPLES}, () =>
        median(Array.from({length: values.length}, () => values[Math.floor(random() * values.length)])))
    return (percentile(medians, 0.975) - percentile(medians, 0.025)) / 2 / median(values)
}

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

// Kernel cost from batches run inside wasm: each batch runs `count` calls once with and once without the
// kernel; the difference per call removes the preparation and the timer. Batches are added until the
// confidence interval is within the target or the cap is reached.
const throughput = (run) => {
    const timeBatch = (count, withKernel) => {
        const start = now()
        run(count, withKernel)
        return now() - start
    }
    const estimate = timeBatch(WARM_UP_CALLS, 1) / WARM_UP_CALLS
    const count = Math.max(1, Math.ceil(BATCH_NS / estimate))
    const samples = []
    const addBatches = (batches) => {
        for (let batch = 0; batch < batches; batch++) {
            const without = timeBatch(count, 0)
            const both = timeBatch(count, 1)
            samples.push((both - without) / count)
        }
    }
    addBatches(MIN_BATCHES)
    while (ciHalfWidth(samples) > CI_TARGET && samples.length < MAX_BATCHES) {
        addBatches(EXTRA_BATCHES)
    }
    return {median: median(samples), ci: ciHalfWidth(samples), batches: samples.length}
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
        result.forward = throughput(wasm.run_forward)
        result.forwardCall = singleCall(wasm.prepare_forward, wasm.forward_kernel)
        if (wasm.has_inverse() === 1) {
            result.inverse = throughput(wasm.run_inverse)
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

const microseconds = (nanoseconds) => (nanoseconds / 1000).toFixed(nanoseconds < 10000 ? 2 : 1)
const cell = (measure) => measure === undefined ? "–"
    : `${microseconds(measure.median)} ±${(measure.ci * 100).toFixed(1)} %${measure.ci > CI_TARGET ? " ⚠" : ""}`
const table = (title, value) => {
    console.log(`### ${title}\n`)
    console.log(`| N | ${options.map(({name}) => name).join(" | ")} |`)
    console.log(`|---|${"---|".repeat(options.length)}`)
    for (const n of sizes) {
        const row = options.map(({name}) => value(results.find((result) => result.name === name && result.n === n)))
        console.log(`| ${n} | ${row.join(" | ")} |`)
    }
    console.log()
}

console.log("## Environment\n\n| Key | Value |\n|---|---|")
environment.forEach(([key, value]) => console.log(`| ${key} | ${value} |`))
console.log("\n## Wasm timings (Node)\n")
console.log(`Throughput: median µs per call with the 95 % CI half-width; ⚠ marks a CI above ${CI_TARGET * 100} % after ${MAX_BATCHES} batches.\n`)
table("Forward, throughput (µs)", (result) => cell(result.forward))
table("Inverse, throughput (µs)", (result) => cell(result.inverse))
table("Forward, single call: median / p99 (µs, includes one timer pair)",
    (result) => `${microseconds(result.forwardCall.median)} / ${microseconds(result.forwardCall.p99)}`)
table("Forward, % of the 128-frame render quantum at 48 kHz",
    (result) => `${(result.forward.median / RENDER_QUANTUM_NS * 100).toFixed(2)} %`)
const stepped = results.filter((result) => result.steps !== undefined)
if (stepped.length > 0) {
    console.log("### Forward steps (stage-wise options): µs per step, median\n")
    console.log("| Option | N | Steps | Largest step | All steps |\n|---|---|---|---|---|")
    stepped.forEach((result) => console.log(`| ${result.name} | ${result.n} | ${result.steps.length} | `
        + `${microseconds(Math.max(...result.steps))} | ${microseconds(result.steps.reduce((sum, value) => sum + value, 0))} |`))
}
