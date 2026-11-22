// Spins performance.now() (ms) into a shared Float64Array, as packages/studio/core/src/HRClockWorker.ts does: the
// worklet has no clock of its own. Burns one core until terminated.
self.onmessage = ({data}) => {
    const now = new Float64Array(data)
    while (true) {
        now[0] = performance.now()
    }
}
