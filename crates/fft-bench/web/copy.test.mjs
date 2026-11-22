// Checks of the page copy: node --test web/copy.test.mjs
import {test} from "node:test"
import assert from "node:assert/strict"
import {GLOSSARY, HINTS, INTRO, QUESTION} from "./copy.mjs"

const introText = () => [...QUESTION, ...INTRO.flatMap(([label, lines]) => [label, ...lines])]

test("intro, glossary and every reading hint are present", () => {
    assert.ok(QUESTION.length > 0 && QUESTION.every((line) => line.length > 0))
    assert.ok(INTRO.length >= 3 && INTRO.every(([label, lines]) => label.length > 0 && lines.length > 0 && lines.every((line) => line.length > 0)))
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
    const text = [...introText(), ...Object.values(HINTS)].join(" ")
    assert.match(text, /realfft/)
    assert.match(text, /simd/)
    assert.doesNotMatch(text, /we recommend|you should choose/i)
})

test("the intro points to the testing concept and the plan", () => {
    const text = introText().join(" ")
    assert.match(text, /docs\/testing-concept\.md/)
    assert.match(text, /future-plans\/simd-fft\.md/)
})

test("every backtick in the intro is paired", () => {
    for (const line of introText()) {
        assert.equal((line.match(/`/g) ?? []).length % 2, 0, line)
    }
})
