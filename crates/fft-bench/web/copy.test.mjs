// Checks of the page copy: node --test web/copy.test.mjs
import {test} from "node:test"
import assert from "node:assert/strict"
import {GLOSSARY, HINTS, INTRO} from "./copy.mjs"

test("intro, glossary and every reading hint are present", () => {
    assert.ok(INTRO.length >= 3 && INTRO.every((paragraph) => paragraph.length > 0))
    assert.ok(GLOSSARY.every(([term, explanation]) => term.length > 0 && explanation.length > 0))
    for (const key of ["overview", "throughputTable", "throughputChart", "libraryChart", "stepsTable", "budgetChart", "budgetTable",
        "environmentTable", "moduleTable"]) {
        assert.ok(HINTS[key]?.length > 0, key)
    }
})

test("the glossary explains the marks the tables use", () => {
    const terms = GLOSSARY.map(([term]) => term).join(" ")
    for (const mark of ["±", "⚠", "render quantum", "proposal"]) {
        assert.ok(terms.includes(mark), mark)
    }
})

test("the copy names the question and makes no recommendation", () => {
    const text = [...INTRO, ...Object.values(HINTS)].join(" ")
    assert.match(text, /realfft/)
    assert.match(text, /simd/)
    assert.doesNotMatch(text, /we recommend|you should choose/i)
})
