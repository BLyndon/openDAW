// Checks of the budget model against hand-computed values: node --test
// Every call takes 1 µs here, so each expected value is the call count divided by the repeat interval.
import {test} from "node:test"
import assert from "node:assert/strict"
import {consumerLoad, CONSUMERS, RENDER_QUANTUM_NS} from "./budget.mjs"

const MICROSECOND = 1000
const everyCall = () => ({forward: MICROSECOND, inverse: MICROSECOND})
const [analyser, stretch, convolver] = CONSUMERS
const real = {name: "real", complex: false}
const complex = {name: "complex", complex: true}
const share = (nanoseconds) => nanoseconds / RENDER_QUANTUM_NS
const assertNear = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} vs ${expected}`)

test("analyser: one forward every 8 quanta, worst case one forward", () => {
    const load = consumerLoad(analyser, real, everyCall)
    assertNear(load.average, share(MICROSECOND / 8))
    assertNear(load.peak, share(MICROSECOND))
})

test("time-stretch: a complex option carries both channels in one call, a real one needs two", () => {
    assertNear(consumerLoad(stretch, complex, everyCall).average, share(2 * MICROSECOND / 8))
    assertNear(consumerLoad(stretch, real, everyCall).average, share(4 * MICROSECOND / 8))
})

test("time-stretch: split computation has no single-quantum worst case", () => {
    assert.equal(consumerLoad(stretch, real, everyCall).peak, undefined)
})

test("convolver: every-quantum level adds forward and inverse, the others the larger of the two", () => {
    const load = consumerLoad(convolver, real, everyCall)
    assertNear(load.average, share(4 * MICROSECOND + 4 * MICROSECOND / 8 + 4 * MICROSECOND / 64))
    assertNear(load.peak, share(4 * MICROSECOND + 2 * MICROSECOND + 2 * MICROSECOND))
})

test("an option without inverse or without a measured size cannot serve the consumer", () => {
    assert.equal(consumerLoad(stretch, real, () => ({forward: MICROSECOND})), undefined)
    assert.equal(consumerLoad(analyser, real, () => undefined), undefined)
})
