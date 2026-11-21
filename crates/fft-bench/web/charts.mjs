// Dependency-free SVG charts, coloured by CSS custom properties (--series-N, --grid, --text-muted).
const WIDTH = 640
const HEIGHT = 320
const MARGIN = {left: 64, right: 32, top: 40, bottom: 44}
const POINT_RADIUS = 4
const BAR_RADIUS = 4
const BAR_GAP = 2
const GROUP_GAP = 24
const LINEAR_TICKS = 4

const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const format = (value) => Number(value.toPrecision(3)).toString()
const plotLeft = MARGIN.left
const plotRight = WIDTH - MARGIN.right
const plotTop = MARGIN.top
const plotBottom = HEIGHT - MARGIN.bottom

const scale = (low, high, log, from, to) => {
    const map = log ? Math.log : (value) => value
    return (value) => from + (map(value) - map(low)) / (map(high) - map(low) || 1) * (to - from)
}

// Log ticks at powers of `base` inside the data range, linear ticks at round steps from zero.
const ticks = (low, high, log, base) => {
    if (log) {
        const first = Math.floor(Math.log(low) / Math.log(base))
        const last = Math.ceil(Math.log(high) / Math.log(base))
        return Array.from({length: last - first + 1}, (_, index) => base ** (first + index))
    }
    const step = 10 ** Math.floor(Math.log10(high / LINEAR_TICKS))
    const niceStep = [1, 2, 5, 10].map((factor) => factor * step).find((candidate) => high / candidate <= LINEAR_TICKS)
    return Array.from({length: Math.ceil(high / niceStep) + 1}, (_, index) => index * niceStep)
}

const legend = (items) => items.length < 2 ? "" : items.map(({name, slot}, index) =>
    `<g class="legend-item" transform="translate(${plotLeft + index * 110},12)">`
    + `<rect width="12" height="12" rx="2" fill="var(--series-${slot})"/>`
    + `<text x="18" y="10" fill="var(--text-secondary)" font-size="12">${escape(name)}</text></g>`).join("")

const frame = (content, yLabel, xLabel) =>
    `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" font-family="inherit" xmlns="http://www.w3.org/2000/svg">${content}`
    + `<text x="14" y="${(plotTop + plotBottom) / 2}" transform="rotate(-90 14 ${(plotTop + plotBottom) / 2})" text-anchor="middle" `
    + `fill="var(--text-muted)" font-size="11">${escape(yLabel)}</text>`
    + (xLabel === undefined ? "" : `<text x="${(plotLeft + plotRight) / 2}" y="${HEIGHT - 6}" text-anchor="middle" fill="var(--text-muted)" `
        + `font-size="11">${escape(xLabel)}</text>`) + "</svg>"

const horizontalGrid = (values, y) => values.map((value) =>
    `<line class="grid" x1="${plotLeft}" x2="${plotRight}" y1="${y(value)}" y2="${y(value)}" stroke="var(--grid)" stroke-width="1"/>`
    + `<text x="${plotLeft - 6}" y="${y(value) + 4}" text-anchor="end" fill="var(--text-muted)" font-size="11">${format(value)}</text>`).join("")

export const lineChart = ({series, xLabel, yLabel, logX, logY}) => {
    const defined = series.flatMap(({points}) => points.filter(([, value]) => value !== undefined))
    const xs = defined.map(([n]) => n)
    const ys = defined.map(([, value]) => value)
    const [xLow, xHigh] = [Math.min(...xs), Math.max(...xs)]
    const yTicks = ticks(logY ? Math.min(...ys) : 0, Math.max(...ys), logY, 10)
    const x = scale(xLow, xHigh, logX, plotLeft, plotRight)
    const y = scale(yTicks[0], yTicks.at(-1), logY, plotBottom, plotTop)
    const xAxis = ticks(xLow, xHigh, logX, 2).filter((value) => value >= xLow && value <= xHigh).map((value) =>
        `<text x="${x(value)}" y="${plotBottom + 16}" text-anchor="middle" fill="var(--text-muted)" font-size="11">${value}</text>`).join("")
    const lines = series.map(({name, slot, points}) => {
        // A gap in the data starts a new segment instead of bridging the missing point.
        const path = points.map(([n, value], index) => value === undefined ? ""
            : `${index === 0 || points[index - 1][1] === undefined ? "M" : "L"}${x(n).toFixed(1)},${y(value).toFixed(1)}`).join("")
        const marks = points.filter(([, value]) => value !== undefined).map(([n, value]) =>
            `<circle class="point" cx="${x(n).toFixed(1)}" cy="${y(value).toFixed(1)}" r="${POINT_RADIUS}" fill="var(--series-${slot})" `
            + `stroke="var(--surface)" stroke-width="2"><title>${escape(name)}, N = ${n}: ${format(value)} ${escape(yLabel)}</title></circle>`).join("")
        return `<path class="line" d="${path}" fill="none" stroke="var(--series-${slot})" stroke-width="2"/>${marks}`
    }).join("")
    return frame(legend(series) + horizontalGrid(yTicks, y) + xAxis + lines, yLabel, xLabel)
}

// Bars are rounded at the data end only and stand square on the baseline.
const barPath = (left, top, width, bottom) => {
    const radius = Math.min(BAR_RADIUS, width / 2, bottom - top)
    return `M${left},${bottom}V${top + radius}Q${left},${top} ${left + radius},${top}H${left + width - radius}`
        + `Q${left + width},${top} ${left + width},${top + radius}V${bottom}Z`
}

export const barChart = ({groups, yLabel, unit}) => {
    const values = groups.flatMap(({bars}) => bars.map(({value}) => value)).filter((value) => value !== undefined)
    const yTicks = ticks(0, Math.max(...values), false, 10)
    const y = scale(0, yTicks.at(-1), false, plotBottom, plotTop)
    const barsPerGroup = Math.max(...groups.map(({bars}) => bars.length))
    const groupWidth = (plotRight - plotLeft - GROUP_GAP * (groups.length - 1)) / groups.length
    const barWidth = (groupWidth - BAR_GAP * (barsPerGroup - 1)) / barsPerGroup
    const legendItems = [...new Map(groups.flatMap(({bars}) => bars).filter(({value}) => value !== undefined)
        .map((bar) => [bar.name, bar])).values()]
    const content = groups.map(({name, bars}, groupIndex) => {
        const groupLeft = plotLeft + groupIndex * (groupWidth + GROUP_GAP)
        const marks = bars.map((bar, barIndex) => bar.value === undefined ? ""
            : `<path class="bar" d="${barPath(groupLeft + barIndex * (barWidth + BAR_GAP), y(bar.value), barWidth, plotBottom)}" `
            + `fill="var(--series-${bar.slot})" data-value="${bar.value}"><title>${escape(name)}, ${escape(bar.name)}: `
            + `${format(bar.value)}${escape(unit)}</title></path>`).join("")
        return marks + `<text x="${groupLeft + groupWidth / 2}" y="${plotBottom + 16}" text-anchor="middle" fill="var(--text-secondary)" `
            + `font-size="12">${escape(name)}</text>`
    }).join("")
    return frame(legend(legendItems) + horizontalGrid(yTicks, y) + content, yLabel, undefined)
}
