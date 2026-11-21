// Checks of the Markdown helpers shared by run.mjs and the browser report: node --test
import {test} from "node:test"
import assert from "node:assert/strict"
import {cell, environmentTable, microseconds, sizeTable, stepTable} from "./markdown.mjs"

const options = [{name: "a"}, {name: "b"}]

test("microseconds: two decimals below 10 µs, one above", () => {
    assert.equal(microseconds(1440), "1.44")
    assert.equal(microseconds(28400), "28.4")
})

test("cell: dash when not measured, CI in percent, warning above the target", () => {
    assert.equal(cell(undefined), "–")
    assert.equal(cell({median: 1440, ci: 0.006}), "1.44 ±0.6 %")
    assert.ok(cell({median: 3990, ci: 0.131}).endsWith(" ⚠"))
})

test("sizeTable: header per option, one row per size, missing results passed as undefined", () => {
    const results = [{name: "a", n: 256, value: "x"}]
    const lines = sizeTable("Title", [256], options, (result) => result?.value ?? "none", results)
    assert.deepEqual(lines, ["### Title", "", "| N | a | b |", "|---|---|---|", "| 256 | x | none |", ""])
})

test("environmentTable: one row per key", () => {
    assert.deepEqual(environmentTable([["cpu", "M1"]]), ["## Environment", "", "| Key | Value |", "|---|---|", "| cpu | M1 |"])
})

test("stepTable: largest and sum of steps, empty without stepped results", () => {
    assert.deepEqual(stepTable([{name: "a", n: 256}]), [])
    const lines = stepTable([{name: "s", n: 256, steps: [1000, 3000]}])
    assert.equal(lines.at(-1), "| s | 256 | 2 | 3.00 | 4.00 |")
})
