// Measurements on the fft-bench wasm exports, shared by the Node runner and the browser Worker. Times are in ns.
import {throughput} from "./stats.mjs"

export const listOptions = (wasm) => {
    const optionName = (option) => new TextDecoder().decode(
        new Uint8Array(wasm.memory.buffer, wasm.option_name_ptr(option), wasm.option_name_len(option)))
    return Array.from({length: wasm.option_count()},
        (_, option) => ({option, name: optionName(option), complex: wasm.option_is_complex(option) === 1}))
}

const throughputOfSetup = (wasm, {direction, now, batchNs}) => direction === "inverse" && wasm.has_inverse() === 0 ? undefined
    : throughput(direction === "forward" ? wasm.run_forward : wasm.run_inverse, now, batchNs)

export const measureThroughput = (wasm, {option, n, direction, now, batchNs}) => {
    wasm.setup(option, n)
    return throughputOfSetup(wasm, {direction, now, batchNs})
}

// The outlook stages (`options::outlook::STAGES`); `batch` is the number of transforms per call.
export const listStages = (wasm) => Array.from({length: wasm.stage_count()}, (_, stage) => ({stage, batch: wasm.stage_batch(stage),
    name: new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, wasm.stage_name_ptr(stage), wasm.stage_name_len(stage)))}))

// Time per transform: the time per call divided by the stage's batch.
export const measureStageThroughput = (wasm, {stage, n, direction, now, batchNs}) => {
    wasm.setup_stage(stage, n)
    const measure = throughputOfSetup(wasm, {direction, now, batchNs})
    const batch = wasm.stage_batch(stage)
    return measure === undefined ? undefined : {...measure, median: measure.median / batch}
}

// Step k is the kernel of a batch prepared by the forward preparation and steps 0..k-1.
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
