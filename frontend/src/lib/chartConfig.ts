export const CHART_COLORS = {
  bgPrimary: '#0b0e11',
  bgCard: '#1e2329',
  bgInput: '#2b3139',
  text: '#848e9c',
  accent: '#f0b90b',
  long: '#0ecb81',
  short: '#f6465d',
  font: 'JetBrains Mono, monospace',
  fontSize: 11,
} as const

export function createDarkChartOptions(overrides: {
  width: number
  height: number
  background?: 'primary' | 'card'
  timeVisible?: boolean
  secondsVisible?: boolean
  crosshairMode?: number
} = { width: 0, height: 0 }): object {
  const bg = overrides.background === 'card' ? CHART_COLORS.bgCard : CHART_COLORS.bgPrimary
  const gridColor = overrides.background === 'card' ? CHART_COLORS.bgInput : CHART_COLORS.bgCard

  return {
    width: overrides.width,
    height: overrides.height,
    layout: {
      background: { color: bg },
      textColor: CHART_COLORS.text,
      fontFamily: CHART_COLORS.font,
      fontSize: CHART_COLORS.fontSize,
    },
    grid: {
      vertLines: { color: gridColor },
      horzLines: { color: gridColor },
    },
    crosshair: {
      ...(overrides.crosshairMode !== undefined ? { mode: overrides.crosshairMode } : {}),
      horzLine: { color: CHART_COLORS.accent, labelBackgroundColor: CHART_COLORS.accent },
      vertLine: { color: CHART_COLORS.accent, labelBackgroundColor: CHART_COLORS.accent },
    },
    timeScale: {
      ...(overrides.timeVisible !== undefined ? { timeVisible: overrides.timeVisible } : {}),
      ...(overrides.secondsVisible !== undefined ? { secondsVisible: overrides.secondsVisible } : {}),
      borderColor: CHART_COLORS.bgInput,
    },
    rightPriceScale: {
      borderColor: CHART_COLORS.bgInput,
    },
  }
}
