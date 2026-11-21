// Checks of the browser environment checks and step outcomes: node --test web/checks.test.mjs
import {test} from "node:test"
import assert from "node:assert/strict"
import {batchNsFor, browserName, evaluateEnvironment, fetchHost, fetchModuleBytes, measureTick, simdSupported, stepOutcome} from "./checks.mjs"

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const FIREFOX = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0"
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15"
const GOOD = {isolated: true, tickNs: 5000, simd: true}

test("measureTick: smallest positive step between consecutive reads", () => {
    const reads = [0, 0, 5000, 5000, 10000]
    let index = 0
    assert.equal(measureTick(() => reads[Math.min(index++, reads.length - 1)], reads.length), 5000)
})

test("measureTick: a clock that never moves has no finite tick", () => {
    assert.equal(measureTick(() => 0, 100), Infinity)
})

test("batchNsFor: at least 10 ms, else 500 ticks", () => {
    assert.equal(batchNsFor(5000), 10e6)
    assert.equal(batchNsFor(100000), 50e6)
})

test("simdSupported: true in Node 24", () => {
    assert.equal(simdSupported(), true)
})

test("simdSupported: false when the engine rejects the probe", () => {
    assert.equal(simdSupported(() => false), false)
})

test("browserName: Chrome, Firefox and Safari with their versions", () => {
    assert.deepEqual(browserName(CHROME), {name: "Chrome", version: "131.0.0.0"})
    assert.deepEqual(browserName(FIREFOX), {name: "Firefox", version: "133.0"})
    assert.deepEqual(browserName(SAFARI), {name: "Safari", version: "26.1"})
    assert.deepEqual(browserName("curl/8"), {name: "unknown", version: "unknown"})
})

test("evaluateEnvironment: not isolated fails and names the headers", () => {
    const result = evaluateEnvironment({...GOOD, isolated: false})
    assert.equal(result.status, "fail")
    assert.ok(result.reasons.some((reason) => reason.includes("Cross-Origin-Opener-Policy")))
})

test("evaluateEnvironment: a coarse timer fails", () => {
    assert.equal(evaluateEnvironment({...GOOD, tickNs: 100000}).status, "fail")
})

test("evaluateEnvironment: missing SIMD128 fails", () => {
    assert.equal(evaluateEnvironment({...GOOD, simd: false}).status, "fail")
})

test("evaluateEnvironment: isolated, fine timer and SIMD128 pass", () => {
    assert.deepEqual(evaluateEnvironment(GOOD), {status: "ok", reasons: []})
})

test("stepOutcome: a hidden tab warns", () => {
    assert.deepEqual(stepOutcome([{ci: 0.01}], {wasHidden: true}), {status: "warn", reasons: ["tab was hidden"]})
})

test("stepOutcome: a CI above 5 % warns, unmeasured entries are ignored", () => {
    assert.equal(stepOutcome([{ci: 0.01}, {ci: 0.08}], {wasHidden: false}).status, "warn")
    assert.deepEqual(stepOutcome([{ci: 0.01}, undefined], {wasHidden: false}), {status: "ok", reasons: []})
})

test("stepOutcome: a hidden tab from an earlier run of the step stays a warning after a rerun", () => {
    assert.deepEqual(stepOutcome([{ci: 0.01}], {wasHidden: false, previous: ["tab was hidden"]}).reasons, ["tab was hidden"])
})

test("fetchHost: a missing, failing or non-JSON endpoint gives undefined", async () => {
    const answer = (ok, json) => async () => ({ok, json: json})
    assert.equal(await fetchHost(answer(false, async () => ({}))), undefined)
    assert.equal(await fetchHost(answer(true, async () => { throw new SyntaxError("Unexpected token '<'") })), undefined)
    assert.equal(await fetchHost(async () => { throw new TypeError("network") }), undefined)
    assert.deepEqual(await fetchHost(answer(true, async () => ({git: "abc"}))), {git: "abc"})
})

test("fetchModuleBytes: a missing module names the rebuild command", async () => {
    await assert.rejects(fetchModuleBytes(async () => ({ok: false, status: 404}), "/fft_bench.wasm"),
        /cargo build --release --target wasm32-unknown-unknown/)
})
