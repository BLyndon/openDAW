// Environment checks and step outcomes for the browser page. Times are in ns.
import {CI_TARGET} from "../stats.mjs"

export const TICK_LIMIT_NS = 20000
export const HIDDEN_REASON = "tab was hidden"
const REBUILD = "cargo build --release --target wasm32-unknown-unknown"
const MIN_BATCH_NS = 10e6
const TICKS_PER_BATCH = 500

// Header, one type () -> v128, one function, its body: no locals, v128.const of 16 zero bytes, end.
export const SIMD_PROBE = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
    0x03, 0x02, 0x01, 0x00,
    0x0a, 0x16, 0x01, 0x14, 0x00, 0xfd, 0x0c, ...new Array(16).fill(0x00), 0x0b])

export const measureTick = (now, samples = 10000) => {
    let tick = Infinity
    let previous = now()
    for (let sample = 1; sample < samples; sample++) {
        const current = now()
        if (current > previous) {
            tick = Math.min(tick, current - previous)
        }
        previous = current
    }
    return tick
}

export const batchNsFor = (tickNs) => Math.max(MIN_BATCH_NS, TICKS_PER_BATCH * tickNs)

export const simdSupported = (validate = (bytes) => WebAssembly.validate(bytes)) => validate(SIMD_PROBE)

// Safari's user agent has no Chrome or Firefox token; Chrome's also names Safari, so the order matters.
export const browserName = (userAgent) => {
    const patterns = [["Firefox", /Firefox\/([\d.]+)/], ["Chrome", /Chrome\/([\d.]+)/], ["Safari", /Version\/([\d.]+).*Safari\//]]
    const match = patterns.map(([name, pattern]) => [name, userAgent.match(pattern)]).find(([, result]) => result !== null)
    return match === undefined ? {name: "unknown", version: "unknown"} : {name: match[0], version: match[1][1]}
}

export const evaluateEnvironment = ({isolated, tickNs, simd}) => {
    const reasons = [
        ...isolated ? [] : ["the page is not cross-origin isolated: serve it with `node web/serve.mjs`, which sets "
            + "Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy"],
        ...tickNs <= TICK_LIMIT_NS ? [] : [`the timer tick is ${(tickNs / 1000).toFixed(0)} µs, above ${TICK_LIMIT_NS / 1000} µs`],
        ...simd ? [] : ["WebAssembly SIMD128 is not available in this browser"]]
    return {status: reasons.length === 0 ? "ok" : "fail", reasons}
}

// `previous` holds the step's reasons before a rerun of single points; a hidden tab taints the whole step.
export const stepOutcome = (measures, {wasHidden, previous = []}) => {
    const unsure = measures.filter((measure) => measure !== undefined && measure.ci > CI_TARGET).length
    const reasons = [
        ...wasHidden || previous.includes(HIDDEN_REASON) ? [HIDDEN_REASON] : [],
        ...unsure === 0 ? [] : [`${unsure} point${unsure === 1 ? "" : "s"} with a CI above ${CI_TARGET * 100} %`]]
    return {status: reasons.length === 0 ? "ok" : "warn", reasons}
}

export const fetchHost = (fetchUrl = (url) => fetch(url)) => Promise.resolve().then(() => fetchUrl("/environment"))
    .then((response) => response.ok ? response.json() : undefined).catch(() => undefined)

export const fetchModuleBytes = async (fetchUrl, url) => {
    const response = await fetchUrl(url)
    if (!response.ok) {
        throw new Error(`module not found (HTTP ${response.status}): build it with \`${REBUILD}\``)
    }
    return response.arrayBuffer()
}

export const headerLine = ({browser, host, tickNs, sha256}) => [`${browser.name} ${browser.version}`, host?.cpu, host?.os,
    host === undefined ? undefined : `git ${host.git}`, tickNs === undefined ? undefined : `timer tick ${(tickNs / 1000).toFixed(1)} µs`,
    sha256 === undefined ? undefined : `module ${sha256}`].filter((part) => part !== undefined).join(" · ")
