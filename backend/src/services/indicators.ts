import { OHLCV } from './market'

export interface CoinIndicators {
  price: number
  ema9: number
  ema20: number
  ema50: number
  rsi: number
  trend: 'BULLISH' | 'BEARISH' | 'SIDEWAYS'
  support: number
  resistance: number
  volRatio: number
  change24h: number
  // MACD
  macd: number
  macdSignal: number
  macdHistogram: number
  // Bollinger Bands
  bbUpper: number
  bbMiddle: number
  bbLower: number
  bbWidth: number
  // Stochastic
  stochK: number
  stochD: number
  // ADX
  adx: number
  plusDI: number
  minusDI: number
  // Fibonacci levels (from recent swing)
  fibLevels: { level: string; price: number }[]
  // Pivot points
  pivot: number
  pivotR1: number
  pivotR2: number
  pivotS1: number
  pivotS2: number
  // Candlestick patterns detected
  patterns: string[]
  // VWAP
  vwap: number
  // ATR
  atr: number
}

// Multi-timeframe indicators
export interface MultiTFIndicators {
  tf15m: CoinIndicators
  tf1h: CoinIndicators
  tf4h: CoinIndicators
}

export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const result: number[] = [values[0]]
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k))
  }
  return result
}

export function sma(values: number[], period: number): number[] {
  const result: number[] = []
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(values[i])
    } else {
      const slice = values.slice(i - period + 1, i + 1)
      result.push(slice.reduce((a, b) => a + b, 0) / period)
    }
  }
  return result
}

export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50

  let gains = 0
  let losses = 0

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) gains += diff
    else losses -= diff
  }

  let avgGain = gains / period
  let avgLoss = losses / period

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period
  }

  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return round2(100 - 100 / (1 + rs))
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

// MACD: EMA12 - EMA26, signal = EMA9 of MACD
function computeMACD(closes: number[]) {
  const ema12 = ema(closes, 12)
  const ema26 = ema(closes, 26)
  const macdLine: number[] = []
  for (let i = 0; i < closes.length; i++) {
    macdLine.push(ema12[i] - ema26[i])
  }
  const signal = ema(macdLine, 9)
  const last = macdLine.length - 1
  return {
    macd: round2(macdLine[last]),
    macdSignal: round2(signal[last]),
    macdHistogram: round2(macdLine[last] - signal[last]),
  }
}

// Bollinger Bands: SMA20 ± 2*stddev
function computeBollingerBands(closes: number[], period = 20) {
  const sma20 = sma(closes, period)
  const last = closes.length - 1
  const middle = sma20[last]

  const slice = closes.slice(-period)
  const mean = slice.reduce((a, b) => a + b, 0) / period
  const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period
  const stddev = Math.sqrt(variance)

  return {
    bbUpper: round2(middle + 2 * stddev),
    bbMiddle: round2(middle),
    bbLower: round2(middle - 2 * stddev),
    bbWidth: round2(((middle + 2 * stddev - (middle - 2 * stddev)) / middle) * 100),
  }
}

// Stochastic Oscillator: %K and %D
function computeStochastic(highs: number[], lows: number[], closes: number[], kPeriod = 14, dPeriod = 3) {
  const kValues: number[] = []
  for (let i = kPeriod - 1; i < closes.length; i++) {
    const sliceH = highs.slice(i - kPeriod + 1, i + 1)
    const sliceL = lows.slice(i - kPeriod + 1, i + 1)
    const highest = Math.max(...sliceH)
    const lowest = Math.min(...sliceL)
    const k = highest === lowest ? 50 : ((closes[i] - lowest) / (highest - lowest)) * 100
    kValues.push(k)
  }
  const dValues = sma(kValues, dPeriod)
  return {
    stochK: round2(kValues[kValues.length - 1]),
    stochD: round2(dValues[dValues.length - 1]),
  }
}

// ADX: Average Directional Index
function computeADX(highs: number[], lows: number[], closes: number[], period = 14) {
  if (closes.length < period + 1) return { adx: 25, plusDI: 25, minusDI: 25 }

  const trueRanges: number[] = []
  const plusDMs: number[] = []
  const minusDMs: number[] = []

  for (let i = 1; i < closes.length; i++) {
    const hl = highs[i] - lows[i]
    const hpc = Math.abs(highs[i] - closes[i - 1])
    const lpc = Math.abs(lows[i] - closes[i - 1])
    trueRanges.push(Math.max(hl, hpc, lpc))

    const upMove = highs[i] - highs[i - 1]
    const downMove = lows[i - 1] - lows[i]
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0)
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0)
  }

  // Wilder's smoothing
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0)
  let smoothPlusDM = plusDMs.slice(0, period).reduce((a, b) => a + b, 0)
  let smoothMinusDM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0)

  const dxValues: number[] = []

  for (let i = period; i < trueRanges.length; i++) {
    atr = atr - atr / period + trueRanges[i]
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDMs[i]
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDMs[i]

    const pdi = atr === 0 ? 0 : (smoothPlusDM / atr) * 100
    const mdi = atr === 0 ? 0 : (smoothMinusDM / atr) * 100
    const diSum = pdi + mdi
    const dx = diSum === 0 ? 0 : (Math.abs(pdi - mdi) / diSum) * 100
    dxValues.push(dx)
  }

  let adx = dxValues.length >= period
    ? dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period
    : dxValues[dxValues.length - 1] ?? 25

  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]) / period
  }

  const lastPDI = atr === 0 ? 0 : (smoothPlusDM / atr) * 100
  const lastMDI = atr === 0 ? 0 : (smoothMinusDM / atr) * 100

  return { adx: round2(adx), plusDI: round2(lastPDI), minusDI: round2(lastMDI) }
}

// ATR
function computeATR(highs: number[], lows: number[], closes: number[], period = 14): number {
  if (closes.length < 2) return 0
  const trs: number[] = []
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ))
  }
  if (trs.length < period) return trs.reduce((a, b) => a + b, 0) / trs.length
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period
  }
  return round2(atr)
}

// VWAP (approximate from available candles)
function computeVWAP(candles: OHLCV[]): number {
  let cumTPV = 0
  let cumVol = 0
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3
    cumTPV += tp * c.volume
    cumVol += c.volume
  }
  return cumVol === 0 ? 0 : round2(cumTPV / cumVol)
}

// Fibonacci retracement from recent swing high/low
function computeFibLevels(highs: number[], lows: number[]): { level: string; price: number }[] {
  // Find recent swing high and swing low in last 30 candles
  const lookback = Math.min(30, highs.length)
  const recentHighs = highs.slice(-lookback)
  const recentLows = lows.slice(-lookback)

  const swingHigh = Math.max(...recentHighs)
  const swingLow = Math.min(...recentLows)
  const diff = swingHigh - swingLow

  const fibs = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
  const labels = ['0%', '23.6%', '38.2%', '50%', '61.8%', '78.6%', '100%']

  return fibs.map((f, i) => ({
    level: labels[i],
    price: round2(swingHigh - diff * f),
  }))
}

// Pivot points (classic)
function computePivotPoints(highs: number[], lows: number[], closes: number[]) {
  // Use last candle as "previous period"
  const h = highs[highs.length - 1]
  const l = lows[lows.length - 1]
  const c = closes[closes.length - 1]
  const pivot = (h + l + c) / 3
  return {
    pivot: round2(pivot),
    pivotR1: round2(2 * pivot - l),
    pivotR2: round2(pivot + (h - l)),
    pivotS1: round2(2 * pivot - h),
    pivotS2: round2(pivot - (h - l)),
  }
}

// Simple candlestick pattern detection
function detectPatterns(candles: OHLCV[]): string[] {
  const patterns: string[] = []
  const len = candles.length
  if (len < 3) return patterns

  const last = candles[len - 1]
  const prev = candles[len - 2]
  const prev2 = candles[len - 3]

  const bodyLast = Math.abs(last.close - last.open)
  const rangeLast = last.high - last.low
  const bodyPrev = Math.abs(prev.close - prev.open)

  // Doji
  if (bodyLast < rangeLast * 0.1 && rangeLast > 0) {
    patterns.push('DOJI')
  }

  // Hammer (small body at top, long lower shadow)
  const lowerShadow = Math.min(last.open, last.close) - last.low
  const upperShadow = last.high - Math.max(last.open, last.close)
  if (lowerShadow > bodyLast * 2 && upperShadow < bodyLast * 0.5 && bodyLast > 0) {
    patterns.push('HAMMER')
  }

  // Shooting Star (small body at bottom, long upper shadow)
  if (upperShadow > bodyLast * 2 && lowerShadow < bodyLast * 0.5 && bodyLast > 0) {
    patterns.push('SHOOTING_STAR')
  }

  // Engulfing
  if (last.close > last.open && prev.close < prev.open &&
    last.open <= prev.close && last.close >= prev.open) {
    patterns.push('BULLISH_ENGULFING')
  }
  if (last.close < last.open && prev.close > prev.open &&
    last.open >= prev.close && last.close <= prev.open) {
    patterns.push('BEARISH_ENGULFING')
  }

  // Morning Star
  if (prev2.close < prev2.open && bodyPrev < bodyLast * 0.3 &&
    last.close > last.open && last.close > (prev2.open + prev2.close) / 2) {
    patterns.push('MORNING_STAR')
  }

  // Evening Star
  if (prev2.close > prev2.open && bodyPrev < bodyLast * 0.3 &&
    last.close < last.open && last.close < (prev2.open + prev2.close) / 2) {
    patterns.push('EVENING_STAR')
  }

  // Three White Soldiers
  if (len >= 3 &&
    prev2.close > prev2.open && prev.close > prev.open && last.close > last.open &&
    prev.close > prev2.close && last.close > prev.close) {
    patterns.push('THREE_WHITE_SOLDIERS')
  }

  // Three Black Crows
  if (len >= 3 &&
    prev2.close < prev2.open && prev.close < prev.open && last.close < last.open &&
    prev.close < prev2.close && last.close < prev.close) {
    patterns.push('THREE_BLACK_CROWS')
  }

  // Double bottom / top detection (simplified)
  if (len >= 10) {
    const recentLows = candles.slice(-10).map(c => c.low)
    const minLow = Math.min(...recentLows)
    const nearMinCount = recentLows.filter(l => l < minLow * 1.005).length
    if (nearMinCount >= 2) patterns.push('DOUBLE_BOTTOM')

    const recentHighs = candles.slice(-10).map(c => c.high)
    const maxHigh = Math.max(...recentHighs)
    const nearMaxCount = recentHighs.filter(h => h > maxHigh * 0.995).length
    if (nearMaxCount >= 2) patterns.push('DOUBLE_TOP')
  }

  return patterns
}

export function computeIndicators(candles: OHLCV[]): CoinIndicators {
  const closes = candles.map((c) => c.close)
  const highs = candles.map((c) => c.high)
  const lows = candles.map((c) => c.low)
  const volumes = candles.map((c) => c.volume)

  const ema9Arr = ema(closes, 9)
  const ema20Arr = ema(closes, 20)
  const ema50Arr = ema(closes, 50)

  const price = closes[closes.length - 1]
  const ema9Val = ema9Arr[ema9Arr.length - 1]
  const ema20Val = ema20Arr[ema20Arr.length - 1]
  const ema50Val = ema50Arr[ema50Arr.length - 1]
  const rsiVal = rsi(closes)

  let trend: 'BULLISH' | 'BEARISH' | 'SIDEWAYS'
  if (ema20Val > ema50Val && price > ema20Val) trend = 'BULLISH'
  else if (ema20Val < ema50Val && price < ema20Val) trend = 'BEARISH'
  else trend = 'SIDEWAYS'

  const last20Lows = lows.slice(-20)
  const last20Highs = highs.slice(-20)
  const support = Math.min(...last20Lows)
  const resistance = Math.max(...last20Highs)

  const lastVol = volumes[volumes.length - 1]
  const avg20Vol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20
  const volRatio = round2(lastVol / avg20Vol)

  // 4h candles: 6 = 24h, but this is used for all timeframes
  const close24hAgo = closes.length > 6 ? closes[closes.length - 7] : closes[0]
  const change24h = round2(((price - close24hAgo) / close24hAgo) * 100)

  const macdData = computeMACD(closes)
  const bbData = computeBollingerBands(closes)
  const stochData = computeStochastic(highs, lows, closes)
  const adxData = computeADX(highs, lows, closes)
  const atr = computeATR(highs, lows, closes)
  const vwap = computeVWAP(candles)
  const fibLevels = computeFibLevels(highs, lows)
  const pivotData = computePivotPoints(highs, lows, closes)
  const patterns = detectPatterns(candles)

  return {
    price: round2(price),
    ema9: round2(ema9Val),
    ema20: round2(ema20Val),
    ema50: round2(ema50Val),
    rsi: round2(rsiVal),
    trend,
    support: round2(support),
    resistance: round2(resistance),
    volRatio,
    change24h,
    ...macdData,
    ...bbData,
    ...stochData,
    ...adxData,
    fibLevels,
    ...pivotData,
    patterns,
    vwap,
    atr,
  }
}
