// Writes web/facts.json, the criteria the browser page cannot measure itself: accuracy gates, allocations, wasm size,
// no_std linking and licences. Run after code changes, before serving the page: node facts.mjs (takes minutes).
import {execFileSync} from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {gitRevision} from "./host.mjs"

// From the crates' own manifests, as listed in analysis/simd-fft-baseline.md.
export const LICENCES = {realfft: "MIT", rustfft: "MIT OR Apache-2.0", own: "AGPL-3.0 (project)"}
// realfft cannot link no_std, so size.sh measures it in a std module against an empty std module.
const SIZE_STUB = {realfft: "realfft-std"}

const licenceOf = (name) => name === "realfft" ? `realfft ${LICENCES.realfft} · rustfft ${LICENCES.rustfft}` : LICENCES.own

export const assembleFacts = ({accuracy, size, nostd, git, date, rustc}) => ({
    generated: {git, date, rustc},
    options: Object.fromEntries(Object.entries(accuracy.options).map(([name, {allocations, ...gates}]) => {
        const stub = size[SIZE_STUB[name] ?? name]
        return [name, {accuracy: gates, allocations, size: stub === undefined ? undefined : {gzipAdded: stub.added, crates: stub.crates},
            noStd: nostd[name]?.links, licence: licenceOf(name)}]
    }))
})

const run = (root, command, commandArguments) =>
    execFileSync(command, commandArguments, {cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 24})

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const root = path.dirname(fileURLToPath(import.meta.url))
    console.error("accuracy and allocations…")
    const accuracy = JSON.parse(run(root, "cargo", ["run", "--release", "--example", "facts"]))
    console.error("wasm size…")
    const size = JSON.parse(run(root, "size/size.sh", ["--json"]))
    console.error("no_std linking…")
    const nostd = JSON.parse(run(root, "size/nostd-check.sh", ["--json"]))
    const facts = assembleFacts({accuracy, size, nostd, git: gitRevision(), date: new Date().toISOString().slice(0, 10),
        rustc: run(root, "rustc", ["--version"]).trim()})
    fs.writeFileSync(path.join(root, "web", "facts.json"), `${JSON.stringify(facts, null, 2)}\n`)
    console.error("wrote web/facts.json")
}
