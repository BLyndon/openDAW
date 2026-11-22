// Runs the measurements off the main thread. Requests are answered one at a time, in order, with the same id.
import {listOptions, listStages, measureStageThroughput, measureSteps, measureThroughput} from "../measure.mjs"
import {fetchModuleBytes, measureTick, simdSupported} from "./checks.mjs"

const now = () => performance.now() * 1e6
let wasm

const hex = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("")

const handlers = {
    environment: () => ({isolated: self.crossOriginIsolated === true, tickNs: measureTick(now), simd: simdSupported()}),
    load: async ({url}) => {
        const bytes = await fetchModuleBytes((target) => fetch(target), url)
        wasm = (await WebAssembly.instantiate(bytes, {})).instance.exports
        return {options: listOptions(wasm), stages: listStages(wasm), bytes: bytes.byteLength, sha256: hex(await crypto.subtle.digest("SHA-256", bytes)).slice(0, 12)}
    },
    throughput: ({option, n, direction, batchNs}) => measureThroughput(wasm, {option, n, direction, now, batchNs}),
    steps: ({option, n, batchNs}) => measureSteps(wasm, {option, n, now, batchNs}),
    stageThroughput: ({stage, n, direction, batchNs}) => measureStageThroughput(wasm, {stage, n, direction, now, batchNs})
}

self.onmessage = ({data: {id, type, ...request}}) => {
    Promise.resolve().then(() => handlers[type](request))
        .then((result) => self.postMessage({id, result}))
        .catch((error) => self.postMessage({id, error: String(error?.message ?? error)}))
}
