// Measurements on the fft-bench wasm exports, shared by the Node runner and the browser Worker. Times are in ns.
import {throughput} from "./stats.mjs"

export const listOptions = (wasm) => {
    const optionName = (option) => new TextDecoder().decode(
        new Uint8Array(wasm.memory.buffer, wasm.option_name_ptr(option), wasm.option_name_len(option)))
    return Array.from({length: wasm.option_count()},
        (_, option) => ({option, name: optionName(option), complex: wasm.option_is_complex(option) === 1}))
}

export const measureThroughput = (wasm, {option, n, direction, now, batchNs}) => {
    wasm.setup(option, n)
    if (direction === "inverse" && wasm.has_inverse() === 0) {
        return undefined
    }
    return throughput(direction === "forward" ? wasm.run_forward : wasm.run_inverse, now, batchNs)
}

// Step k as the kernel of a batch whose preparation is the forward preparation and steps 0..k-1, so the
// difference with and without the kernel is step k alone, as its consumer runs it after the steps before.
export const measureSteps = (wasm, {option, n, now, batchNs}) => {
    wasm.setup(option, n)
    return Array.from({length: wasm.steps()}, (_, kernelStep) => throughput((count, withKernel) => {
        for (let call = 0; call < count; call++) {
            wasm.prepare_forward()
            for (let step = 0; step < kernelStep; step++) {
                wasm.run_step(step)
            }
            if (withKernel === 1) {
                wasm.run_step(kernelStep)
            }
        }
    }, now, batchNs))
}
