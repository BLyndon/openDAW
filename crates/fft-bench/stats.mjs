// Timing statistics shared by the Node runner and the browser page. Times are in ns.
export const WARM_UP_CALLS = 200
export const MIN_BATCHES = 30
export const MAX_BATCHES = 120
export const EXTRA_BATCHES = 10
export const CI_TARGET = 0.05
const BOOTSTRAP_SAMPLES = 1000
const BOOTSTRAP_SEED = 0x12345678

export const median = (values) => {
    const sorted = [...values].sort((left, right) => left - right)
    const middle = sorted.length >> 1
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export const percentile = (values, fraction) => {
    const sorted = [...values].sort((left, right) => left - right)
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

// 95 % bootstrap CI half-width relative to the median, seeded so a rerun gives the same interval.
export const ciHalfWidth = (values) => {
    const center = median(values)
    if (center <= 0) {
        return Infinity
    }
    let state = BOOTSTRAP_SEED
    const random = () => {
        state ^= state << 13
        state ^= state >>> 17
        state ^= state << 5
        return (state >>> 0) / 4294967296
    }
    const medians = Array.from({length: BOOTSTRAP_SAMPLES}, () =>
        median(Array.from({length: values.length}, () => values[Math.floor(random() * values.length)])))
    return (percentile(medians, 0.975) - percentile(medians, 0.025)) / 2 / center
}

// Per-call kernel cost: batches with minus without the kernel, added until the CI meets the target or the cap.
export const throughput = (run, now, batchNs) => {
    const timeBatch = (count, withKernel) => {
        const start = now()
        run(count, withKernel)
        return now() - start
    }
    const estimate = Math.max(1, timeBatch(WARM_UP_CALLS, 1) / WARM_UP_CALLS)
    const count = Math.max(1, Math.ceil(batchNs / estimate))
    const samples = []
    const addBatches = (batches) => {
        for (let batch = 0; batch < batches; batch++) {
            const without = timeBatch(count, 0)
            const both = timeBatch(count, 1)
            samples.push((both - without) / count)
        }
    }
    addBatches(MIN_BATCHES)
    while (ciHalfWidth(samples) > CI_TARGET && samples.length < MAX_BATCHES) {
        addBatches(EXTRA_BATCHES)
    }
    return {median: median(samples), ci: ciHalfWidth(samples), batches: samples.length}
}
