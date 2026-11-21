// Serves the browser page cross-origin isolated, so browsers give it their finest timer.
// Build first: cargo build --release --target wasm32-unknown-unknown
// Usage (from crates/fft-bench): node web/serve.mjs [--port 8080]
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {gitRevision, hostInfo, moduleIsStale} from "../host.mjs"

const DEFAULT_PORT = 8080
const SHARED_MODULES = ["stats.mjs", "measure.mjs", "budget.mjs", "markdown.mjs"]
const CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm"}
const ISOLATION = {"Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp"}

// Only files listed here are served; request paths are looked up, never joined onto the file system.
const routes = (root, modulePath) => {
    const web = path.join(root, "web")
    const pageFiles = fs.readdirSync(web).filter((name) => !name.endsWith(".test.mjs") && name !== "serve.mjs")
    return new Map([
        ["/", path.join(web, "index.html")],
        ["/fft_bench.wasm", modulePath],
        ...SHARED_MODULES.map((name) => [`/${name}`, path.join(root, name)]),
        ...pageFiles.map((name) => [`/web/${name}`, path.join(web, name)])])
}

export const createServer = ({root, modulePath, sourceDirs}) => {
    const files = routes(root, modulePath)
    return http.createServer((request, response) => {
        if (request.url === "/environment") {
            const body = JSON.stringify({git: gitRevision(), ...hostInfo(), module: path.relative(root, modulePath),
                moduleStale: moduleIsStale(modulePath, sourceDirs)})
            response.writeHead(200, {...ISOLATION, "Content-Type": "application/json"}).end(body)
            return
        }
        const file = files.get(request.url)
        if (file === undefined || !fs.existsSync(file)) {
            response.writeHead(404, ISOLATION).end("not found")
            return
        }
        response.writeHead(200, {...ISOLATION, "Content-Type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream"})
        fs.createReadStream(file).pipe(response)
    })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
    const portIndex = process.argv.indexOf("--port")
    const port = portIndex > 0 ? Number(process.argv[portIndex + 1]) : DEFAULT_PORT
    const sourceDirs = ["src", "../dsp/src", "../math/src", "../signalsmith/src"].map((directory) => path.join(root, directory))
    const server = createServer({root, modulePath: path.join(root, "target/wasm32-unknown-unknown/release/fft_bench.wasm"), sourceDirs})
    server.listen(port, "127.0.0.1", () => console.log(`fft-bench page: http://127.0.0.1:${port}/`))
}
