// Checks of the Worker request client: node --test web/client.test.mjs
import {test} from "node:test"
import assert from "node:assert/strict"
import {createClient} from "./client.mjs"

const fakeWorker = () => ({posted: [], postMessage(message) { this.posted.push(message) }})

test("a result answers the request with the same id", async () => {
    const worker = fakeWorker()
    const request = createClient(worker)
    const answer = request("environment")
    worker.onmessage({data: {id: worker.posted[0].id, result: 42}})
    assert.equal(await answer, 42)
})

test("an error answer rejects with its message", async () => {
    const worker = fakeWorker()
    const request = createClient(worker)
    const answer = request("load", {url: "/fft_bench.wasm"})
    worker.onmessage({data: {id: worker.posted[0].id, error: "trap"}})
    await assert.rejects(answer, /trap/)
})

test("a worker that fails to load rejects every pending request instead of hanging", async () => {
    const worker = fakeWorker()
    const request = createClient(worker)
    const answers = [request("environment"), request("load")]
    worker.onerror({message: "Failed to load module script"})
    for (const answer of answers) {
        await assert.rejects(answer, /worker failed: Failed to load module script/)
    }
})
