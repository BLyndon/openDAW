// Checks of the fixed step order of the browser page: node --test web/sequence.test.mjs
import {test} from "node:test"
import assert from "node:assert/strict"
import {createSequence, STEPS} from "./sequence.mjs"

const OK = {status: "ok", reasons: [], data: {}}
const states = (sequence) => STEPS.map(({id}) => sequence.state(id))
const complete = (sequence, ids) => ids.forEach((id) => {
    sequence.start(id)
    sequence.finish(id, OK)
})

test("the steps run in the spec's order", () => {
    assert.deepEqual(STEPS.map(({id}) => id), ["environment", "module", "forward", "inverse", "steps", "budget", "report"])
    assert.ok(STEPS.every(({title, purpose, expected}) => [title, purpose, expected].every((text) => text.length > 0)))
})

test("initially only the environment step is ready", () => {
    assert.deepEqual(states(createSequence()), ["ready", "locked", "locked", "locked", "locked", "locked", "locked"])
})

test("a failed step keeps every later step locked", () => {
    const sequence = createSequence()
    sequence.start("environment")
    sequence.finish("environment", {status: "fail", reasons: ["not isolated"], data: {}})
    assert.equal(sequence.state("module"), "locked")
    assert.deepEqual(sequence.reasons("environment"), ["not isolated"])
    assert.equal(sequence.canRun("module"), false)
    assert.equal(sequence.canRun("environment"), true)
})

test("a warning unlocks the next step", () => {
    const sequence = createSequence()
    complete(sequence, ["environment", "module"])
    sequence.start("forward")
    sequence.finish("forward", {status: "warn", reasons: ["1 point"], data: {}})
    assert.equal(sequence.state("inverse"), "ready")
})

test("replacing a point resets every later step and keeps the next one ready", () => {
    const sequence = createSequence()
    complete(sequence, ["environment", "module", "forward", "inverse", "steps", "budget"])
    sequence.replacePoint("forward", "rfft/1024", {median: 7000, ci: 0.01})
    assert.deepEqual(states(sequence), ["ok", "ok", "ok", "ready", "locked", "locked", "locked"])
    assert.deepEqual(sequence.data("forward")["rfft/1024"], {median: 7000, ci: 0.01})
    assert.deepEqual(sequence.data("budget"), undefined)
})

test("a rerun of an earlier step resets every later step", () => {
    const sequence = createSequence()
    complete(sequence, ["environment", "module", "forward"])
    complete(sequence, ["environment"])
    assert.deepEqual(states(sequence), ["ok", "ready", "locked", "locked", "locked", "locked", "locked"])
})

test("starting a locked step throws, and nothing runs while a step is running", () => {
    const sequence = createSequence()
    assert.throws(() => sequence.start("module"))
    sequence.start("environment")
    assert.equal(sequence.state("environment"), "running")
    assert.equal(sequence.canRun("environment"), false)
})
