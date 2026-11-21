// Facts about the machine and the checkout, shared by the Node runner and the browser page server.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {spawnSync} from "node:child_process"

const git = (...gitArguments) => {
    const result = spawnSync("git", gitArguments, {encoding: "utf8"})
    return result.status === 0 ? result.stdout.trim() : undefined
}

export const gitRevision = () => {
    const hash = git("rev-parse", "--short", "HEAD")
    return hash === undefined ? "unknown" : `${hash}${git("status", "--porcelain", "--untracked-files=no") === "" ? "" : "-dirty"}`
}

export const hostInfo = () => ({cpu: os.cpus()[0]?.model ?? "unknown", arch: os.arch(), os: `${os.type()} ${os.release()}`})

const newestModification = (directory) => fs.readdirSync(directory, {withFileTypes: true}).reduce((newest, entry) => {
    const entryPath = path.join(directory, entry.name)
    return Math.max(newest, entry.isDirectory() ? newestModification(entryPath) : fs.statSync(entryPath).mtimeMs)
}, 0)

// True if the module is missing or any file under the source directories changed after it was built.
export const moduleIsStale = (modulePath, sourceDirs) => !fs.existsSync(modulePath)
    || sourceDirs.some((directory) => newestModification(directory) > fs.statSync(modulePath).mtimeMs)
