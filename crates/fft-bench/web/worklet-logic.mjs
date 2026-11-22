// Shared by the AudioWorklet processor, the Worker and the worklet page: the block schedule, the record layout,
// the per-block call count and the bit digests. No TextDecoder and no performance: neither exists in a worklet.

export const WORKLET_OPTIONS = ["rfft", "realfft", "simd", "simd-o1o4"]
export const WORKLET_SIZES = [256, 1024, 4096, 16384]
export const DIRECTIONS = ["forward", "inverse"]
export const RENDER_QUANTUM = 128
export const LOAD_FRACTION = 0.25
// control[1] of a timing run.
export const STATUS = {running: 1, done: 2}
// Calibration doubles the calls until one timing lasts this long; it is far above the 5–20 µs tick.
const CALIBRATION_NS = 100e3
const MAX_CALIBRATION_CALLS = 4096

export const asciiName = (memory, pointer, length) => String.fromCharCode(...new Uint8Array(memory.buffer, pointer, length))

export const listOptionsAscii = (wasm) => Array.from({length: wasm.option_count()},
    (_, option) => ({option, name: asciiName(wasm.memory, wasm.option_name_ptr(option), wasm.option_name_len(option))}))

// Per round and job: one setup block, one calibration block, then `pairs` × (without kernel, with kernel).
export const blocksPerJob = (pairs) => 2 + 2 * pairs

export const totalBlocks = ({jobCount, rounds, pairs}) => rounds * jobCount * blocksPerJob(pairs)

export const blockAt = (index, {jobCount, pairs}) => {
    const perJob = blocksPerJob(pairs)
    const round = Math.floor(index / (jobCount * perJob))
    const job = Math.floor(index / perJob) % jobCount
    const offset = index % perJob
    if (offset === 0) {
        return {kind: "setup", round, job}
    }
    if (offset === 1) {
        return {kind: "calibrate", round, job}
    }
    const measured = offset - 2
    return {kind: "measure", round, job, pair: measured >> 1, withKernel: measured & 1}
}

export const recordIndex = ({round, job, pair, withKernel}, {jobCount, pairs}) => ((round * jobCount + job) * pairs + pair) * 2 + withKernel

export const countIndex = ({round, job}, {jobCount}) => round * jobCount + job

// Calls per measured block so that one block's work is `fraction` of the render quantum.
export const countFor = (estimateNs, quantumNs, fraction = LOAD_FRACTION) => Math.max(1, Math.floor(fraction * quantumNs / Math.max(estimateNs, 1)))

// ns per call of `run(calls, 1)`, doubling the calls until a timing reaches CALIBRATION_NS; `now` returns ns.
export const calibrate = (run, now) => {
    let calls = 1
    while (true) {
        const start = now()
        run(calls, 1)
        const elapsed = now() - start
        if (elapsed >= CALIBRATION_NS || calls >= MAX_CALIBRATION_CALLS) {
            return elapsed / calls
        }
        calls *= 2
    }
}

// NaN drops the block: the clock never started, or it stood still through a kernel batch (its Worker was descheduled).
// A batch without the kernel may be shorter than one tick, so a standing clock is valid there.
export const blockDuration = (startMs, endMs, withKernel) => startMs > 0 && (endMs > startMs || (withKernel === 0 && endMs === startMs))
    ? (endMs - startMs) * 1e6 : NaN

// Per-call kernel time of every complete pair of one job, rounds before `firstRound` left out (cold code).
export const pairDifferences = (records, counts, job, shape, firstRound = 1) => {
    const differences = []
    let dropped = 0
    for (let round = firstRound; round < shape.rounds; round++) {
        const count = counts[countIndex({round, job}, shape)]
        for (let pair = 0; pair < shape.pairs; pair++) {
            const without = records[recordIndex({round, job, pair, withKernel: 0}, shape)]
            const both = records[recordIndex({round, job, pair, withKernel: 1}, shape)]
            if (Number.isNaN(without) || Number.isNaN(both)) {
                dropped++
            } else {
                differences.push((both - without) / count)
            }
        }
    }
    return {differences, dropped}
}

// FNV-1a over the bit patterns of `length` f32 values.
export const digest = (memory, pointer, length, hash = 0x811c9dc5) => {
    const words = new Uint32Array(memory.buffer, pointer, length)
    for (let index = 0; index < length; index++) {
        hash = Math.imul(hash ^ words[index], 0x01000193) >>> 0
    }
    return hash
}

// One digest of input, forward re/im and inverse output per option, size and signal.
export const digestCases = (wasm, optionNames = WORKLET_OPTIONS, sizes = WORKLET_SIZES) => {
    const options = listOptionsAscii(wasm).filter(({name}) => optionNames.includes(name))
    return options.flatMap(({option, name}) => sizes.flatMap((n) => Array.from({length: wasm.signal_count()}, (_, signal) => {
        wasm.setup_signal(option, n, signal)
        const bins = n / 2 + 1
        const hash = [[wasm.input_ptr(), n], [wasm.re_ptr(), bins], [wasm.im_ptr(), bins], [wasm.output_ptr(), n]]
            .reduce((value, [pointer, length]) => digest(wasm.memory, pointer, length, value), 0x811c9dc5)
        return {name, n, signal, hash}
    })))
}
