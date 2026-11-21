// Checks of the shared timing statistics: node --test
import {test} from "node:test"
import assert from "node:assert/strict"
import {ciHalfWidth, median, percentile, throughput} from "./stats.mjs"

const BATCH_NS = 10e6

// A clock that only moves when the fake kernel runs: 150 ns per call with the kernel, 50 ns without.
const fakeRun = () => {
    let clock = 0
    const counts = []
    const run = (count, withKernel) => {
        counts.push(count)
        clock += count * (withKernel === 1 ? 150 : 50)
    }
    return {run, now: () => clock, counts}
}

test("median of odd and even counts", () => {
    assert.equal(median([3, 1, 2]), 2)
    assert.equal(median([4, 1, 3, 2]), 2.5)
})

test("percentile picks the value at the fraction", () => {
    assert.equal(percentile(Array.from({length: 100}, (_, index) => index + 1), 0.99), 100)
})

test("CI of constant samples is zero and reproducible", () => {
    assert.equal(ciHalfWidth(Array(50).fill(7)), 0)
    const samples = Array.from({length: 40}, (_, index) => 100 + (index % 7))
    assert.equal(ciHalfWidth(samples), ciHalfWidth(samples))
})

test("throughput is the per-call difference with and without the kernel", () => {
    const {run, now} = fakeRun()
    const result = throughput(run, now, BATCH_NS)
    assert.equal(result.median, 100)
    assert.equal(result.ci, 0)
    assert.equal(result.batches, 30)
})

test("throughput sizes batches from the estimate and the batch length", () => {
    const {run, now, counts} = fakeRun()
    throughput(run, now, BATCH_NS)
    assert.ok(counts.slice(1).every((count) => count === Math.ceil(BATCH_NS / 150)))
})

test("CI of a median at or below zero is infinite, so the point is flagged", () => {
    assert.equal(ciHalfWidth([-3, -1, 0, 1, 2]), Infinity)
    assert.equal(ciHalfWidth([-5, -4, -3, -2, -1]), Infinity)
})

test("throughput ends when the warm-up is shorter than one timer tick", () => {
    let clock = 0
    const result = throughput(() => {}, () => clock, BATCH_NS)
    assert.equal(result.batches, 120)
    assert.equal(result.ci, Infinity)
})
