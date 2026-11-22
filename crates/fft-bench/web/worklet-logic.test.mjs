// Checks of the worklet schedule, record layout, calibration and digests: node --test web/worklet-logic.test.mjs
import {test} from "node:test"
import assert from "node:assert/strict"
import {asciiName, blockAt, blockDuration, blocksPerJob, calibrate, countFor, countIndex, digest, pairDifferences, recordIndex,
    totalBlocks} from "./worklet-logic.mjs"

const shape = {jobCount: 3, rounds: 2, pairs: 2}

test("blockAt: per job a setup, a calibration, then alternating without and with kernel", () => {
    const kinds = Array.from({length: blocksPerJob(shape.pairs)}, (_, index) => blockAt(index, shape))
    assert.deepEqual(kinds, [
        {kind: "setup", round: 0, job: 0}, {kind: "calibrate", round: 0, job: 0},
        {kind: "measure", round: 0, job: 0, pair: 0, withKernel: 0}, {kind: "measure", round: 0, job: 0, pair: 0, withKernel: 1},
        {kind: "measure", round: 0, job: 0, pair: 1, withKernel: 0}, {kind: "measure", round: 0, job: 0, pair: 1, withKernel: 1}])
})

test("blockAt: jobs interleave within a round, rounds follow each other", () => {
    const perJob = blocksPerJob(shape.pairs)
    assert.deepEqual(blockAt(perJob, shape), {kind: "setup", round: 0, job: 1})
    assert.deepEqual(blockAt(3 * perJob, shape), {kind: "setup", round: 1, job: 0})
    assert.deepEqual(blockAt(totalBlocks(shape) - 1, shape), {kind: "measure", round: 1, job: 2, pair: 1, withKernel: 1})
})

test("recordIndex and countIndex: every measured block and every round-job get their own slot", () => {
    const records = new Set()
    const counts = new Set()
    for (let index = 0; index < totalBlocks(shape); index++) {
        const block = blockAt(index, shape)
        if (block.kind === "measure") {
            records.add(recordIndex(block, shape))
        }
        counts.add(countIndex(block, shape))
    }
    assert.equal(records.size, shape.rounds * shape.jobCount * shape.pairs * 2)
    assert.deepEqual([...records].sort((left, right) => left - right), [...Array(records.size).keys()])
    assert.equal(counts.size, shape.rounds * shape.jobCount)
})

test("countFor: a quarter of the quantum by default, at least one call", () => {
    assert.equal(countFor(1000, 2_666_667), 666)
    assert.equal(countFor(1000, 2_666_667, 0.5), 1333)
    assert.equal(countFor(5_000_000, 2_666_667), 1)
    assert.equal(countFor(0, 1000), 250)
})

test("calibrate: doubles the calls until a timing reaches 100 µs", () => {
    let clock = 0
    const calls = []
    const run = (count) => {
        calls.push(count)
        clock += count * 1000
    }
    assert.equal(calibrate(run, () => clock), 1000)
    assert.deepEqual(calls, [1, 2, 4, 8, 16, 32, 64, 128])
})

test("blockDuration: ns between two clock reads; a clock that never ran or stood still through a kernel batch drops it", () => {
    assert.equal(blockDuration(10, 10.5, 1), 500_000)
    assert.ok(Number.isNaN(blockDuration(10, 10, 1)))
    assert.equal(blockDuration(10, 10, 0), 0, "a batch without the kernel may fit in one tick")
    assert.ok(Number.isNaN(blockDuration(0, 0, 0)))
    assert.ok(Number.isNaN(blockDuration(10, 9, 0)))
})

test("pairDifferences: per-call kernel time from each pair, round 0 and incomplete pairs left out", () => {
    const records = new Float64Array(shape.rounds * shape.jobCount * shape.pairs * 2).fill(NaN)
    const counts = new Float64Array(shape.rounds * shape.jobCount).fill(10)
    const set = (round, job, pair, without, both) => {
        records[recordIndex({round, job, pair, withKernel: 0}, shape)] = without
        records[recordIndex({round, job, pair, withKernel: 1}, shape)] = both
    }
    set(0, 1, 0, 100, 9999)
    set(1, 1, 0, 100, 300)
    set(1, 1, 1, NaN, 300)
    assert.deepEqual(pairDifferences(records, counts, 1, shape), {differences: [20], dropped: 1})
})

test("digest: FNV-1a over the bit patterns; any changed bit changes it", () => {
    const memory = {buffer: new Float32Array([1, 2, 3]).buffer}
    const base = digest(memory, 0, 3)
    assert.equal(digest({buffer: new Uint32Array(0).buffer}, 0, 0), 0x811c9dc5)
    new Float32Array(memory.buffer)[2] = 3.0000002
    assert.notEqual(digest(memory, 0, 3), base)
})

test("asciiName reads names without TextDecoder", () => {
    const bytes = new Uint8Array([0, 0, 115, 105, 109, 100])
    assert.equal(asciiName({buffer: bytes.buffer}, 2, 4), "simd")
})
