// Checks of the facts file assembly: node --test facts.test.mjs
import {test} from "node:test"
import assert from "node:assert/strict"
import {assembleFacts} from "./facts.mjs"

const accuracy = (worst) => ({rms: {worst, gate: 2.4e-7, pass: true}, roundTrip: {worst: 9e-8, limit: 1e-5, pass: true},
    contract: {worst: 1.8e-7, limit: 1e-5, pass: true}, allocations: 0})
const SIMD_ACCURACY = accuracy(1.4e-7)
const REALFFT_ACCURACY = accuracy(1.5e-7)

test("assembleFacts maps stubs to options and keeps provenance", () => {
    const facts = assembleFacts({accuracy: {options: {simd: SIMD_ACCURACY, realfft: REALFFT_ACCURACY}},
        size: {simd: {gzip: 9000, added: 3100, crates: 3}, "realfft-std": {gzip: 40000, added: 21000, crates: 9}},
        nostd: {simd: {links: true, error: null}, realfft: {links: false, error: "duplicate lang item"}},
        git: "abc1234", date: "2026-11-22", rustc: "rustc 1.93.0"})
    assert.deepEqual(facts.generated, {git: "abc1234", date: "2026-11-22", rustc: "rustc 1.93.0"})
    assert.equal(facts.options.realfft.size.gzipAdded, 21000)
    assert.equal(facts.options.realfft.noStd, false)
    assert.equal(facts.options.simd.size.crates, 3)
    assert.equal(facts.options.simd.noStd, true)
    assert.match(facts.options.realfft.licence, /rustfft/)
    assert.equal(facts.options.simd.allocations, 0)
    assert.equal(facts.options.simd.accuracy.rms.worst, 1.4e-7)
})

test("assembleFacts leaves an option without size data undefined, not zero", () => {
    const facts = assembleFacts({accuracy: {options: {rfft: SIMD_ACCURACY}}, size: {}, nostd: {}, git: "x", date: "d", rustc: "r"})
    assert.equal(facts.options.rfft.size, undefined)
    assert.equal(facts.options.rfft.noStd, undefined)
})
