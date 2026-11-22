// The fft-bench module on the audio thread. Mode "bits" posts the digests of every case once; mode "timing" runs one
// schedule block per process() call and writes each measured block's duration into shared memory.
import {simdSupported} from "./checks.mjs"
import {blockAt, blockDuration, calibrate, countFor, countIndex, digestCases, listOptionsAscii, recordIndex, RENDER_QUANTUM, STATUS,
    totalBlocks} from "./worklet-logic.mjs"

class FftBenchProcessor extends AudioWorkletProcessor {
    constructor({processorOptions}) {
        super()
        const {module, bytes, mode, clock, control, counts, records, jobs, shape} = processorOptions
        this.wasm = new WebAssembly.Instance(module ?? new WebAssembly.Module(bytes), {}).exports
        this.port.postMessage({type: "loaded", options: listOptionsAscii(this.wasm).map(({name}) => name), simd: simdSupported(),
            sampleRate})
        this.block = 0
        this.total = 0
        if (mode === "bits") {
            this.port.postMessage({type: "bits", cases: digestCases(this.wasm)})
            return
        }
        this.clock = new Float64Array(clock)
        this.control = new Int32Array(control)
        this.counts = new Float64Array(counts)
        this.records = new Float64Array(records)
        this.jobs = jobs
        this.shape = shape
        this.total = totalBlocks(shape)
        this.quantumNs = RENDER_QUANTUM / sampleRate * 1e9
        Atomics.store(this.control, 1, STATUS.running)
    }

    process() {
        if (this.block >= this.total) {
            return true
        }
        const block = blockAt(this.block, this.shape)
        const {option, n, direction} = this.jobs[block.job]
        const run = direction === "forward" ? this.wasm.run_forward : this.wasm.run_inverse
        if (block.kind === "setup") {
            this.wasm.setup(option, n)
        } else if (block.kind === "calibrate") {
            const estimate = calibrate(run, () => this.clock[0] * 1e6)
            this.counts[countIndex(block, this.shape)] = countFor(estimate, this.quantumNs)
        } else {
            const count = this.counts[countIndex(block, this.shape)]
            const start = this.clock[0]
            run(count, block.withKernel)
            this.records[recordIndex(block, this.shape)] = blockDuration(start, this.clock[0], block.withKernel)
        }
        this.block++
        Atomics.store(this.control, 0, this.block)
        if (this.block === this.total) {
            Atomics.store(this.control, 1, STATUS.done)
        }
        return true
    }
}

registerProcessor("fft-bench", FftBenchProcessor)
