// Checks of the measurement core against a fake module with a fake clock: node --test
import {test} from "node:test"
import assert from "node:assert/strict"
import {listOptions, measureSteps, measureThroughput} from "./measure.mjs"

const BATCH_NS = 10e6

// The clock only moves when the fake module runs: prepare 5 ns, step k (k + 1) × 10 ns, a forward or inverse
// batch 150 ns per call with the kernel and 50 ns without.
const fakeModule = ({inverse = 1, steps = 0} = {}) => {
    let clock = 0
    const names = new TextEncoder().encode("rfftsignalsmith")
    const memory = {buffer: names.buffer}
    const batch = (count, withKernel) => { clock += count * (withKernel === 1 ? 150 : 50) }
    const wasm = {
        memory,
        option_count: () => 2,
        option_name_ptr: (option) => option === 0 ? 0 : 4,
        option_name_len: (option) => option === 0 ? 4 : 11,
        option_is_complex: (option) => option,
        setup: () => {},
        has_inverse: () => inverse,
        steps: () => steps,
        prepare_forward: () => { clock += 5 },
        run_step: (step) => { clock += (step + 1) * 10 },
        run_forward: batch,
        run_inverse: batch
    }
    return {wasm, now: () => clock}
}

test("listOptions reads names and the complex flag from the module", () => {
    const {wasm} = fakeModule()
    assert.deepEqual(listOptions(wasm), [
        {option: 0, name: "rfft", complex: false},
        {option: 1, name: "signalsmith", complex: true}])
})

test("measureThroughput: forward kernel cost per call", () => {
    const {wasm, now} = fakeModule()
    assert.equal(measureThroughput(wasm, {option: 0, n: 1024, direction: "forward", now, batchNs: BATCH_NS}).median, 100)
})

test("measureThroughput: undefined for the inverse of an option without one", () => {
    const {wasm, now} = fakeModule({inverse: 0})
    assert.equal(measureThroughput(wasm, {option: 0, n: 1024, direction: "inverse", now, batchNs: BATCH_NS}), undefined)
})

test("measureSteps: each step by the difference of neighbouring prefixes", () => {
    const {wasm, now} = fakeModule({steps: 3})
    const steps = measureSteps(wasm, {option: 1, n: 1024, now, batchNs: BATCH_NS})
    assert.deepEqual(steps.map((step) => step.median), [10, 20, 30])
})

test("measureSteps: empty for an option without steps", () => {
    const {wasm, now} = fakeModule()
    assert.deepEqual(measureSteps(wasm, {option: 0, n: 1024, now, batchNs: BATCH_NS}), [])
})
