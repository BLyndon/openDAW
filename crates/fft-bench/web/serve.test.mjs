// Checks of the browser page server and the host helpers: node --test web/serve.test.mjs
import {test, after} from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import {moduleIsStale} from "../host.mjs"
import {createServer, portFrom} from "./serve.mjs"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fft-bench-serve-"))
fs.mkdirSync(path.join(root, "web"))
fs.mkdirSync(path.join(root, "src"))
fs.writeFileSync(path.join(root, "web", "index.html"), "<!doctype html>")
fs.writeFileSync(path.join(root, "run.mjs"), "secret")
fs.writeFileSync(path.join(root, "src", "lib.rs"), "")
const modulePath = path.join(root, "fft_bench.wasm")
fs.writeFileSync(modulePath, new Uint8Array([0, 97, 115, 109]))
const past = new Date(Date.now() - 60000)
fs.utimesSync(path.join(root, "src", "lib.rs"), past, past)
const server = createServer({root, modulePath, sourceDirs: [path.join(root, "src")]})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const port = server.address().port
after(() => server.close())

// Raw request, so paths like /web/../run.mjs reach the server unnormalised.
const get = (requestPath) => new Promise((resolve) => http.get({host: "127.0.0.1", port, path: requestPath}, (response) => {
    const chunks = []
    response.on("data", (chunk) => chunks.push(chunk))
    response.on("end", () => resolve({status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString()}))
}))

test("every response is cross-origin isolated", async () => {
    for (const requestPath of ["/", "/missing"]) {
        const {headers} = await get(requestPath)
        assert.equal(headers["cross-origin-opener-policy"], "same-origin")
        assert.equal(headers["cross-origin-embedder-policy"], "require-corp")
    }
})

test("index and module are served with their content types", async () => {
    const index = await get("/")
    assert.equal(index.status, 200)
    assert.match(index.headers["content-type"], /^text\/html/)
    assert.equal((await get("/fft_bench.wasm")).headers["content-type"], "application/wasm")
})

test("paths outside the allowlist are not served", async () => {
    for (const requestPath of ["/../run.mjs", "/web/../run.mjs", "/run.mjs", "/web/%2e%2e/run.mjs"]) {
        assert.equal((await get(requestPath)).status, 404, requestPath)
    }
})

test("environment reports git, host and module state", async () => {
    const environment = JSON.parse((await get("/environment")).body)
    assert.deepEqual(Object.keys(environment).sort(), ["arch", "cpu", "git", "module", "moduleStale", "os"])
    assert.equal(environment.moduleStale, false)
})

test("a module older than a source file is stale", () => {
    assert.equal(moduleIsStale(modulePath, [path.join(root, "src")]), false)
    const future = new Date(Date.now() + 60000)
    fs.utimesSync(path.join(root, "src", "lib.rs"), future, future)
    assert.equal(moduleIsStale(modulePath, [path.join(root, "src")]), true)
    assert.equal(moduleIsStale(path.join(root, "missing.wasm"), [path.join(root, "src")]), true)
})

test("the shipped page says how to serve it when its script cannot run", () => {
    const page = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8")
    assert.match(page, /<div id="steps">[^<]*node web\/serve\.mjs[^<]*<\/div>/)
})

test("query strings do not change the route", async () => {
    assert.equal((await get("/?run=1")).status, 200)
    assert.equal((await get("/environment?fresh")).status, 200)
})

test("portFrom: the given port, the default without one, an error for a bad one", () => {
    assert.equal(portFrom(["node", "serve.mjs"]), 8080)
    assert.equal(portFrom(["node", "serve.mjs", "--port", "8090"]), 8090)
    assert.throws(() => portFrom(["node", "serve.mjs", "--port"]), /--port needs a number/)
    assert.throws(() => portFrom(["node", "serve.mjs", "--port", "abc"]), /--port needs a number/)
})
