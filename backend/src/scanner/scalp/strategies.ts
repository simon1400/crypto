import { CoinIndicators, MultiTFIndicators } from '../../services/indicators'

// Scalp strategies — micro-timeframe mean reversion
// Looking for overextended price that will snap back within 1h candle
// TFs: 1m (trigger), 5m (setup), 15m (context)

export interface ScalpSignal {
  coin: string
  type: 'LONG' | 'SHORT'
  strategy: string
  confidence: number     // 0-10
  maxConfidence: number
  reasons: string[]
  indicators: ScalpIndicators
}

export interface ScalpIndicators {
  tf1m: CoinIndicators
  tf5m: CoinIndicators
  tf15m: CoinIndicators
}

// === Strategy 1: Bollinger Band Bounce ===
// Price touches outer BB on 5m with RSI confirmation
// Entry: at BB touch, TP: BB middle, SL: beyond BB by ATR fraction
function bbBounce(coin: string, ind: ScalpIndicators): ScalpSignal | null {
  const { tf1m, tf5m, tf15m } = ind

  const longCheck = checkBBBounceLong(tf1m, tf5m, tf15m)
  const shortCheck = checkBBBounceShort(tf1m, tf5m, tf15m)

  if (longCheck.score > shortCheck.score && longCheck.score >= 3) {
    return {
      coin, type: 'LONG', strategy: 'bb_bounce',
      confidence: longCheck.score, maxConfidence: 10,
      reasons: longCheck.reasons, indicators: ind,
    }
  }
  if (shortCheck.score > longCheck.score && shortCheck.score >= 3) {
    return {
      coin, type: 'SHORT', strategy: 'bb_bounce',
      confidence: shortCheck.score, maxConfidence: 10,
      reasons: shortCheck.reasons, indicators: ind,
    }
  }
  return null
}

function checkBBBounceLong(tf1m: CoinIndicators, tf5m: CoinIndicators, tf15m: CoinIndicators) {
  let score = 0
  const reasons: string[] = []

  // Price at or below lower BB on 5m
  if (tf5m.price <= tf5m.bbLower * 1.001) {
    score += 3
    reasons.push(`Цена у нижней BB 5m ($${tf5m.bbLower.toFixed(2)})`)
  } else if (tf5m.price <= tf5m.bbLower * 1.003) {
    score += 1
    reasons.push(`Цена рядом с нижней BB 5m`)
  }

  // RSI oversold on 5m
  if (tf5m.rsi < 25) { score += 2; reasons.push(`RSI 5m = ${tf5m.rsi} — сильная перепроданность`) }
  else if (tf5m.rsi < 35) { score += 1; reasons.push(`RSI 5m = ${tf5m.rsi} — перепроданность`) }

  // 1m showing reversal (RSI turning up from extreme)
  if (tf1m.rsi > tf5m.rsi && tf1m.rsi < 45) {
    score += 1
    reasons.push('RSI 1m разворачивается вверх')
  }

  // Stochastic oversold on 5m
  if (tf5m.stochK < 15) { score += 1; reasons.push(`Stoch 5m = ${tf5m.stochK} — дно`) }

  // 15m context: not in strong downtrend (we want range/mild)
  if (tf15m.trend !== 'BEARISH') { score += 1; reasons.push('15m не в сильном даунтренде') }

  // Price below VWAP (undervalued relative to session)
  if (tf5m.price < tf5m.vwap * 0.998) {
    score += 1
    reasons.push('Цена ниже VWAP 5m')
  }

  return { score, reasons }
}

function checkBBBounceShort(tf1m: CoinIndicators, tf5m: CoinIndicators, tf15m: CoinIndicators) {
  let score = 0
  const reasons: string[] = []

  if (tf5m.price >= tf5m.bbUpper * 0.999) {
    score += 3
    reasons.push(`Цена у верхней BB 5m ($${tf5m.bbUpper.toFixed(2)})`)
  } else if (tf5m.price >= tf5m.bbUpper * 0.997) {
    score += 1
    reasons.push(`Цена рядом с верхней BB 5m`)
  }

  if (tf5m.rsi > 75) { score += 2; reasons.push(`RSI 5m = ${tf5m.rsi} — сильная перекупленность`) }
  else if (tf5m.rsi > 65) { score += 1; reasons.push(`RSI 5m = ${tf5m.rsi} — перекупленность`) }

  if (tf1m.rsi < tf5m.rsi && tf1m.rsi > 55) {
    score += 1
    reasons.push('RSI 1m разворачивается вниз')
  }

  if (tf5m.stochK > 85) { score += 1; reasons.push(`Stoch 5m = ${tf5m.stochK} — потолок`) }

  if (tf15m.trend !== 'BULLISH') { score += 1; reasons.push('15m не в сильном аптренде') }

  if (tf5m.price > tf5m.vwap * 1.002) {
    score += 1
    reasons.push('Цена выше VWAP 5m')
  }

  return { score, reasons }
}

// === Strategy 2: RSI Snap ===
// Extreme RSI on 1m+5m simultaneously → fast snap back
// More aggressive than BB bounce, shorter hold
function rsiSnap(coin: string, ind: ScalpIndicators): ScalpSignal | null {
  const { tf1m, tf5m, tf15m } = ind

  const longCheck = checkRsiSnapLong(tf1m, tf5m, tf15m)
  const shortCheck = checkRsiSnapShort(tf1m, tf5m, tf15m)

  if (longCheck.score > shortCheck.score && longCheck.score >= 3) {
    return {
      coin, type: 'LONG', strategy: 'rsi_snap',
      confidence: longCheck.score, maxConfidence: 8,
      reasons: longCheck.reasons, indicators: ind,
    }
  }
  if (shortCheck.score > longCheck.score && shortCheck.score >= 3) {
    return {
      coin, type: 'SHORT', strategy: 'rsi_snap',
      confidence: shortCheck.score, maxConfidence: 8,
      reasons: shortCheck.reasons, indicators: ind,
    }
  }
  return null
}

function checkRsiSnapLong(tf1m: CoinIndicators, tf5m: CoinIndicators, tf15m: CoinIndicators) {
  let score = 0
  const reasons: string[] = []

  // Both 1m and 5m RSI oversold
  if (tf1m.rsi < 20 && tf5m.rsi < 30) {
    score += 3
    reasons.push(`RSI 1m=${tf1m.rsi} + 5m=${tf5m.rsi} — двойная перепроданность`)
  } else if (tf1m.rsi < 25) {
    score += 2
    reasons.push(`RSI 1m = ${tf1m.rsi} — экстрим`)
  }

  // Price spike down (sharp move creates snap opportunity)
  if (tf5m.change24h < -0.5) {
    score += 1
    reasons.push(`Резкое падение: ${tf5m.change24h}%`)
  }

  // Volume spike on the move (confirms real move, not drift)
  if (tf5m.volRatio > 2.0) {
    score += 1
    reasons.push(`Всплеск объёма: ${tf5m.volRatio}x`)
  }

  // 15m not deeply bearish
  if (tf15m.rsi > 35) { score += 1; reasons.push('15m RSI не в зоне краха') }

  return { score, reasons }
}

function checkRsiSnapShort(tf1m: CoinIndicators, tf5m: CoinIndicators, tf15m: CoinIndicators) {
  let score = 0
  const reasons: string[] = []

  if (tf1m.rsi > 80 && tf5m.rsi > 70) {
    score += 3
    reasons.push(`RSI 1m=${tf1m.rsi} + 5m=${tf5m.rsi} — двойная перекупленность`)
  } else if (tf1m.rsi > 75) {
    score += 2
    reasons.push(`RSI 1m = ${tf1m.rsi} — экстрим`)
  }

  if (tf5m.change24h > 0.5) {
    score += 1
    reasons.push(`Резкий рост: +${tf5m.change24h}%`)
  }

  if (tf5m.volRatio > 2.0) {
    score += 1
    reasons.push(`Всплеск объёма: ${tf5m.volRatio}x`)
  }

  if (tf15m.rsi < 65) { score += 1; reasons.push('15m RSI не в зоне эйфории') }

  return { score, reasons }
}

// === Strategy 3: VWAP Reversion ===
// Price deviated far from VWAP → expect reversion to mean
function vwapRevert(coin: string, ind: ScalpIndicators): ScalpSignal | null {
  const { tf1m, tf5m, tf15m } = ind

  const longCheck = checkVwapLong(tf1m, tf5m, tf15m)
  const shortCheck = checkVwapShort(tf1m, tf5m, tf15m)

  if (longCheck.score > shortCheck.score && longCheck.score >= 3) {
    return {
      coin, type: 'LONG', strategy: 'vwap_revert',
      confidence: longCheck.score, maxConfidence: 8,
      reasons: longCheck.reasons, indicators: ind,
    }
  }
  if (shortCheck.score > longCheck.score && shortCheck.score >= 3) {
    return {
      coin, type: 'SHORT', strategy: 'vwap_revert',
      confidence: shortCheck.score, maxConfidence: 8,
      reasons: shortCheck.reasons, indicators: ind,
    }
  }
  return null
}

function checkVwapLong(tf1m: CoinIndicators, tf5m: CoinIndicators, tf15m: CoinIndicators) {
  let score = 0
  const reasons: string[] = []

  // Price significantly below VWAP on 5m
  const vwapDev = (tf5m.vwap - tf5m.price) / tf5m.price * 100
  if (vwapDev > 0.4) {
    score += 3
    reasons.push(`Цена на ${vwapDev.toFixed(2)}% ниже VWAP 5m`)
  } else if (vwapDev > 0.2) {
    score += 1
    reasons.push(`Цена на ${vwapDev.toFixed(2)}% ниже VWAP 5m`)
  }

  // Also below VWAP on 15m (stronger)
  if (tf15m.price < tf15m.vwap * 0.997) {
    score += 1
    reasons.push('Ниже VWAP и на 15m')
  }

  // RSI not deeply oversold (avoid catching falling knife)
  if (tf5m.rsi > 25 && tf5m.rsi < 45) {
    score += 1
    reasons.push(`RSI 5m = ${tf5m.rsi} — не в падении`)
  }

  // Price near support on 5m
  if (tf5m.price <= tf5m.support * 1.003) {
    score += 2
    reasons.push(`У поддержки 5m ($${tf5m.support.toFixed(2)})`)
  }

  // Volume present
  if (tf5m.volRatio > 1.2) { score += 1; reasons.push(`Объём: ${tf5m.volRatio}x`) }

  return { score, reasons }
}

function checkVwapShort(tf1m: CoinIndicators, tf5m: CoinIndicators, tf15m: CoinIndicators) {
  let score = 0
  const reasons: string[] = []

  const vwapDev = (tf5m.price - tf5m.vwap) / tf5m.price * 100
  if (vwapDev > 0.4) {
    score += 3
    reasons.push(`Цена на ${vwapDev.toFixed(2)}% выше VWAP 5m`)
  } else if (vwapDev > 0.2) {
    score += 1
    reasons.push(`Цена на ${vwapDev.toFixed(2)}% выше VWAP 5m`)
  }

  if (tf15m.price > tf15m.vwap * 1.003) {
    score += 1
    reasons.push('Выше VWAP и на 15m')
  }

  if (tf5m.rsi > 55 && tf5m.rsi < 75) {
    score += 1
    reasons.push(`RSI 5m = ${tf5m.rsi} — не в ракете`)
  }

  if (tf5m.price >= tf5m.resistance * 0.997) {
    score += 2
    reasons.push(`У сопротивления 5m ($${tf5m.resistance.toFixed(2)})`)
  }

  if (tf5m.volRatio > 1.2) { score += 1; reasons.push(`Объём: ${tf5m.volRatio}x`) }

  return { score, reasons }
}

// Run all scalp strategies and return best
export function runScalpStrategies(coin: string, ind: ScalpIndicators): ScalpSignal | null {
  const signals: ScalpSignal[] = []

  const bb = bbBounce(coin, ind)
  if (bb) signals.push(bb)

  const rsi = rsiSnap(coin, ind)
  if (rsi) signals.push(rsi)

  const vwap = vwapRevert(coin, ind)
  if (vwap) signals.push(vwap)

  if (signals.length === 0) return null

  signals.sort((a, b) => (b.confidence / b.maxConfidence) - (a.confidence / a.maxConfidence))
  return signals[0]
}
