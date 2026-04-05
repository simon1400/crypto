// Client-side indicator computation for backtester
// Ported from backend/src/services/indicators.ts — adapted to return full arrays

// EMA — identical to backend version
export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return []
  const k = 2 / (period + 1)
  const result: number[] = [values[0]]
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k))
  }
  return result
}

// RSI series — returns RSI value for EACH bar
// First `period` entries = 50 (neutral), then Wilder smoothing
export function rsiSeries(closes: number[], period = 14): number[] {
  const result: number[] = new Array(closes.length).fill(50)
  if (closes.length < period + 1) return result

  // Seed avgGain/avgLoss on first `period` bars
  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) avgGain += diff
    else avgLoss -= diff
  }
  avgGain /= period
  avgLoss /= period

  if (avgLoss === 0) {
    result[period] = 100
  } else {
    const rs = avgGain / avgLoss
    result[period] = 100 - 100 / (1 + rs)
  }

  // Wilder smoothing from period+1 onward
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period
    if (avgLoss === 0) {
      result[i] = 100
    } else {
      const rs = avgGain / avgLoss
      result[i] = 100 - 100 / (1 + rs)
    }
  }

  return result
}

// MACD series — returns full arrays for MACD line, signal line, and histogram
export function macdSeries(closes: number[]): { macd: number[]; signal: number[]; histogram: number[] } {
  const ema12 = ema(closes, 12)
  const ema26 = ema(closes, 26)

  const macdLine: number[] = []
  for (let i = 0; i < closes.length; i++) {
    macdLine.push(ema12[i] - ema26[i])
  }

  const signalLine = ema(macdLine, 9)

  const histogram: number[] = []
  for (let i = 0; i < macdLine.length; i++) {
    histogram.push(macdLine[i] - signalLine[i])
  }

  return { macd: macdLine, signal: signalLine, histogram }
}
