// Checks that the wasm build (SIMD128) of the simd kernel and of the outlook stages gives the same bits as the native
// build (scalar [f32; 4] fallback), for every size and signal: docs/simd-kernel.md § B.5. Exits 1 on the first difference.
// Build first: cargo build --release --target wasm32-unknown-unknown. Usage: node bits.mjs [module.wasm]
import {execFileSync} from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {moduleIsStale} from "./host.mjs"

const DEFAULT_MODULE = "target/wasm32-unknown-unknown/release/fft_bench.wasm"
const HEX_PER_VALUE = 8

const valueOf = (hex) => new DataView(Uint8Array.from(Buffer.from(hex, "hex")).buffer).getFloat32(0, true)

// Index and both values of the first differing f32, or undefined if the hex strings are equal.
export const firstDifference = (expected, actual) => {
    if (expected === actual) {
        return undefined
    }
    if (expected.length !== actual.length) {
        return {index: -1, expected: `${expected.length / HEX_PER_VALUE} values`, actual: `${actual.length / HEX_PER_VALUE} values`}
    }
    let offset = 0
    while (expected.slice(offset, offset + HEX_PER_VALUE) === actual.slice(offset, offset + HEX_PER_VALUE)) {
        offset += HEX_PER_VALUE
    }
    const [want, got] = [expected, actual].map((hex) => hex.slice(offset, offset + HEX_PER_VALUE))
    return {index: offset / HEX_PER_VALUE, expected: `${valueOf(want)} (${want})`, actual: `${valueOf(got)} (${got})`}
}

const wasmHex = (wasm, pointer, length) => Buffer.from(wasm.memory.buffer, pointer, length * 4).toString("hex")

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const root = path.dirname(fileURLToPath(import.meta.url))
    const modulePath = path.resolve(root, process.argv[2] ?? DEFAULT_MODULE)
    if (moduleIsStale(modulePath, [path.join(root, "src")])) {
        console.error(`${modulePath} is missing or older than src/: cargo build --release --target wasm32-unknown-unknown`)
        process.exit(1)
    }
    const {instance} = await WebAssembly.instantiate(fs.readFileSync(modulePath), {})
    const wasm = instance.exports
    const reference = execFileSync("cargo", ["run", "--quiet", "--release", "--example", "bits"],
        {cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 28})
    const cases = reference.trim().split("\n").map((line) => JSON.parse(line))
    for (const {option, stage, name, n, signal, signalName, ...expected} of cases) {
        stage === undefined ? wasm.setup_signal(option, n, signal) : wasm.setup_stage_signal(stage, n, signal)
        const bins = n / 2 + 1
        const actual = {input: wasmHex(wasm, wasm.input_ptr(), n), re: wasmHex(wasm, wasm.re_ptr(), bins),
            im: wasmHex(wasm, wasm.im_ptr(), bins), output: wasmHex(wasm, wasm.output_ptr(), n)}
        for (const buffer of ["input", "re", "im", "output"]) {
            const difference = firstDifference(expected[buffer], actual[buffer])
            if (difference !== undefined) {
                console.error(`${name}, n = ${n}, ${signalName}: ${buffer}[${difference.index}] native ${difference.expected}, wasm ${difference.actual}`)
                process.exit(1)
            }
        }
    }
    console.log(`${cases.length} cases bit-identical (input, forward re/im, inverse output)`)
}
