// Checks of the bit comparison in bits.mjs: node --test bits.test.mjs
import {test} from "node:test"
import assert from "node:assert/strict"
import {firstDifference} from "./bits.mjs"

// f32 little-endian: 1.0 = 0000803f, 2.0 = 00000040, -0.0 = 00000080.
test("firstDifference finds no difference in equal bits", () => {
    assert.equal(firstDifference("0000803f00000040", "0000803f00000040"), undefined)
})

test("firstDifference reports the index and values of the first differing f32", () => {
    assert.deepEqual(firstDifference("0000803f00000040", "0000803f0000803f"),
        {index: 1, expected: "2 (00000040)", actual: "1 (0000803f)"})
})

test("firstDifference tells 0.0 from -0.0", () => {
    assert.equal(firstDifference("00000000", "00000080").index, 0)
})

test("firstDifference reports a length mismatch", () => {
    assert.equal(firstDifference("0000803f", "0000803f00000040").index, -1)
})
