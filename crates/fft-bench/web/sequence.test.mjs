// Checks of the fixed step order of the browser page: node --test web/sequence.test.mjs
import {test} from "node:test"
import assert from "node:assert/strict"
import {createSequence, runAll, runStep, STEPS} from "./sequence.mjs"

const OK = {status: "ok", reasons: [], data: {}}
const states = (sequence) => STEPS.map(({id}) => sequence.state(id))
const complete = (sequence, ids) => ids.forEach((id) => {
    sequence.start(id)
    sequence.finish(id, OK)
})

test("the steps run in the spec's order", () => {
    assert.deepEqual(STEPS.map(({id}) => id), ["environment", "module", "forward", "inverse", "steps", "budget", "report"])
    assert.ok(STEPS.every(({title, what, why, how, expected}) => [title, what, why, how, expected].every((text) => text?.length > 0)))
    assert.ok(STEPS.every((step) => step.purpose === undefined), "purpose is replaced by what / why / how")
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

test("runStep: a failing step ends as fail with its message, and the page can run again", async () => {
    const sequence = createSequence()
    await runStep(sequence, "environment", async () => { throw new Error("worker trapped") })
    assert.equal(sequence.state("environment"), "fail")
    assert.deepEqual(sequence.reasons("environment"), ["worker trapped"])
    assert.equal(sequence.canRun("environment"), true)
})

test("runStep: a successful step finishes with its outcome", async () => {
    const sequence = createSequence()
    await runStep(sequence, "environment", async () => OK)
    assert.equal(sequence.state("module"), "ready")
})

test("runAll runs every step in order", async () => {
    const sequence = createSequence()
    const ran = []
    const failed = await runAll(sequence, (id) => runStep(sequence, id, () => (ran.push(id), OK)))
    assert.equal(failed, undefined)
    assert.deepEqual(ran, STEPS.map(({id}) => id))
    assert.ok(states(sequence).every((state) => state === "ok"))
})

test("runAll stops at the first failing step and leaves the later ones locked", async () => {
    const sequence = createSequence()
    const ran = []
    const failed = await runAll(sequence, (id) => runStep(sequence, id, () => {
        ran.push(id)
        return id === "forward" ? {status: "fail", reasons: ["worker died"], data: {}} : OK
    }))
    assert.equal(failed, "forward")
    assert.deepEqual(ran, ["environment", "module", "forward"])
    assert.equal(sequence.state("inverse"), "locked")
})

test("runAll starts over from the first step after a complete run", async () => {
    const sequence = createSequence()
    await runAll(sequence, (id) => runStep(sequence, id, () => OK))
    const ran = []
    await runAll(sequence, (id) => runStep(sequence, id, () => (ran.push(id), OK)))
    assert.equal(ran.length, STEPS.length)
})
