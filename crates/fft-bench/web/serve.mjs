// Serves the browser page cross-origin isolated: node web/serve.mjs [--port 8080], after the wasm build.
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {gitRevision, hostInfo, moduleIsStale} from "../host.mjs"

const DEFAULT_PORT = 8080
const SHARED_MODULES = ["stats.mjs", "measure.mjs", "budget.mjs", "markdown.mjs"]
const CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json"}
const ISOLATION = {"Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp"}

// Only files listed here are served; request paths are looked up, never joined onto the file system.
const routes = (root, modulePath) => {
    const web = path.join(root, "web")
    const pageFiles = fs.readdirSync(web).filter((name) => !name.endsWith(".test.mjs") && name !== "serve.mjs")
    return new Map([
        ["/", path.join(web, "index.html")],
        ["/stages", path.join(web, "stages.html")],
        ["/web/facts.json", path.join(web, "facts.json")],
        ["/fft_bench.wasm", modulePath],
        ...SHARED_MODULES.map((name) => [`/${name}`, path.join(root, name)]),
        ...pageFiles.map((name) => [`/web/${name}`, path.join(web, name)])])
}

export const createServer = ({root, modulePath, sourceDirs}) => {
    const files = routes(root, modulePath)
    return http.createServer((request, response) => {
        const route = new URL(request.url, "http://localhost").pathname
        if (route === "/environment") {
            const body = JSON.stringify({git: gitRevision(), ...hostInfo(), module: path.relative(root, modulePath),
                moduleStale: moduleIsStale(modulePath, sourceDirs), factsStale: moduleIsStale(path.join(root, "web", "facts.json"), sourceDirs)})
            response.writeHead(200, {...ISOLATION, "Content-Type": "application/json"}).end(body)
            return
        }
        const file = files.get(route)
        if (file === undefined || !fs.existsSync(file)) {
            response.writeHead(404, ISOLATION).end("not found")
            return
        }
        response.writeHead(200, {...ISOLATION, "Content-Type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream"})
        fs.createReadStream(file).on("error", () => response.destroy()).pipe(response)
    })
}

export const portFrom = (argv) => {
    const index = argv.indexOf("--port")
    if (index < 0) {
        return DEFAULT_PORT
    }
    const port = Number(argv[index + 1])
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error("--port needs a number between 1 and 65535")
    }
    return port
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
    const port = portFrom(process.argv)
    const sourceDirs = ["src", "../dsp/src", "../math/src", "../signalsmith/src"].map((directory) => path.join(root, directory))
    const server = createServer({root, modulePath: path.join(root, "target/wasm32-unknown-unknown/release/fft_bench.wasm"), sourceDirs})
    server.listen(port, "127.0.0.1", () => console.log(`fft-bench page: http://127.0.0.1:${port}/`))
}
