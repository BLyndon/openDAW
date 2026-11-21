// Request and answer over the Worker: each request gets an id, and a Worker that fails rejects everything pending.
export const createClient = (worker) => {
    const pending = new Map()
    let nextRequest = 0
    worker.onmessage = ({data: {id, result, error}}) => {
        const {resolve, reject} = pending.get(id)
        pending.delete(id)
        error === undefined ? resolve(result) : reject(new Error(error))
    }
    worker.onerror = (event) => {
        pending.forEach(({reject}) => reject(new Error(`worker failed: ${event.message ?? "unknown error"}`)))
        pending.clear()
    }
    return (type, payload = {}) => new Promise((resolve, reject) => {
        const id = nextRequest++
        pending.set(id, {resolve, reject})
        worker.postMessage({id, type, ...payload})
    })
}
