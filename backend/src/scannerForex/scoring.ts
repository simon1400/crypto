import { CoinIndicators } from '../services/indicators'

export type ForexSetupType = 'LONG' | 'SHORT' | null

export interface ForexScoreBreakdown {
  total: number // 0-100
  trend: number // 0-40 (ТФ alignment + EMA alignment)
  momentum: number // 0-30 (RSI + MACD + Stoch)
  structure: number // 0-30 (HH/HL или LH/LL + pivot/S-R + ADX)
  setupType: ForexSetupType
  reasons: string[] // human-readable breakdown for GPT/UI
}

interface TF {
  m30: CoinIndicators
  h1: CoinIndicators
  h4: CoinIndicators
}

export function scoreForexSetup(tf: TF): ForexScoreBreakdown {
  const reasons: string[] = []

  // === 1. Trend alignment across timeframes (0-40) ===
  // Best: all 3 TFs aligned BULLISH or all 3 BEARISH
  const trends = [tf.m30.trendDetail, tf.h1.trendDetail, tf.h4.trendDetail]
  const bullishCount = trends.filter((t) => t === 'BULLISH' || t === 'BULLISH_PULLBACK').length
  const bearishCount = trends.filter((t) => t === 'BEARISH' || t === 'BEARISH_PULLBACK').length

  let setupType: ForexSetupType = null
  let trendScore = 0

  if (bullishCount >= 2 && bearishCount <= 1) {
    setupType = 'LONG'
    trendScore = bullishCount === 3 ? 30 : 22  // было 30/20
    reasons.push(`Тренд: ${bullishCount}/3 ТФ bullish (mixed=${bearishCount})`)

    // H1 как primary signal TF — если 2/3 и H1 в bull-наборе, маленький бонус
    if (bullishCount === 2 && (tf.h1.trendDetail === 'BULLISH' || tf.h1.trendDetail === 'BULLISH_PULLBACK')) {
      trendScore += 3
      reasons.push('H1 в bull-наборе')
    }

    // Bonus: все 3 ТФ "чистые" BULLISH (не PULLBACK)
    if (bullishCount === 3 && trends.every((t) => t === 'BULLISH')) {
      trendScore += 3
      reasons.push('Чистый bullish без pullback')
    }

    // Bonus: H4 above EMA200 (higher-TF bias strong)
    if (tf.h4.price > tf.h4.ema200) {
      trendScore += 5
      reasons.push('H4 цена > EMA200')
    }
    // Bonus: H1 EMA20 > EMA50 (clean alignment)
    if (tf.h1.ema20 > tf.h1.ema50) {
      trendScore += 5
      reasons.push('H1 EMA20 > EMA50')
    }
  } else if (bearishCount >= 2 && bullishCount <= 1) {
    setupType = 'SHORT'
    trendScore = bearishCount === 3 ? 30 : 22

    reasons.push(`Тренд: ${bearishCount}/3 ТФ bearish (mixed=${bullishCount})`)

    if (bearishCount === 2 && (tf.h1.trendDetail === 'BEARISH' || tf.h1.trendDetail === 'BEARISH_PULLBACK')) {
      trendScore += 3
      reasons.push('H1 в bear-наборе')
    }

    if (bearishCount === 3 && trends.every((t) => t === 'BEARISH')) {
      trendScore += 3
      reasons.push('Чистый bearish без pullback')
    }

    if (tf.h4.price < tf.h4.ema200) {
      trendScore += 5
      reasons.push('H4 цена < EMA200')
    }
    if (tf.h1.ema20 < tf.h1.ema50) {
      trendScore += 5
      reasons.push('H1 EMA20 < EMA50')
    }
  } else {
    return {
      total: 0,
      trend: 0,
      momentum: 0,
      structure: 0,
      setupType: null,
      reasons: ['Тренды не выровнены между ТФ'],
    }
  }

  // === 2. Momentum (0-30) — on H1 as primary signal TF ===
  let momentumScore = 0

  if (setupType === 'LONG') {
    // RSI: 40-65 = healthy (not overbought, not bearish)
    if (tf.h1.rsi >= 45 && tf.h1.rsi <= 65) {
      momentumScore += 10
      reasons.push(`H1 RSI healthy (${tf.h1.rsi})`)
    } else if (tf.h1.rsi > 65 && tf.h1.rsi <= 75) {
      momentumScore += 5
      reasons.push(`H1 RSI high but ok (${tf.h1.rsi})`)
    } else if (tf.h1.rsi > 75) {
      reasons.push(`H1 RSI перекуплен (${tf.h1.rsi})`)
      // no points, but don't kill setup — trend-follow can work
    }
    // MACD bullish: histogram > 0 or MACD above signal
    if (tf.h1.macdHistogram > 0 || tf.h1.macd > tf.h1.macdSignal) {
      momentumScore += 10
      reasons.push('H1 MACD bullish')
    }
    // Stoch bullish: %K > %D and below 80
    if (tf.h1.stochK > tf.h1.stochD && tf.h1.stochK < 80) {
      momentumScore += 10
      reasons.push('H1 Stoch bullish cross')
    }
  } else {
    // SHORT mirror
    if (tf.h1.rsi <= 55 && tf.h1.rsi >= 35) {
      momentumScore += 10
      reasons.push(`H1 RSI healthy (${tf.h1.rsi})`)
    } else if (tf.h1.rsi < 35 && tf.h1.rsi >= 25) {
      momentumScore += 5
      reasons.push(`H1 RSI low but ok (${tf.h1.rsi})`)
    } else if (tf.h1.rsi < 25) {
      reasons.push(`H1 RSI перепродан (${tf.h1.rsi})`)
    }
    if (tf.h1.macdHistogram < 0 || tf.h1.macd < tf.h1.macdSignal) {
      momentumScore += 10
      reasons.push('H1 MACD bearish')
    }
    if (tf.h1.stochK < tf.h1.stochD && tf.h1.stochK > 20) {
      momentumScore += 10
      reasons.push('H1 Stoch bearish cross')
    }
  }

  // === 3. Structure (0-30) — HH/HL pattern + ADX + pivot ===
  let structureScore = 0

  if (setupType === 'LONG') {
    // Market structure: HH_HL is textbook uptrend
    if (tf.h1.marketStructure === 'HH_HL' || tf.h4.marketStructure === 'HH_HL') {
      structureScore += 10
      reasons.push('Структура HH/HL')
    }
    // ADX > 25 = trending (directional strength)
    if (tf.h1.adx > 25 && tf.h1.plusDI > tf.h1.minusDI) {
      structureScore += 10
      reasons.push(`H1 ADX ${tf.h1.adx} (trending, +DI>-DI)`)
    } else if (tf.h1.adx > 20) {
      structureScore += 5
    }
    // Price above H1 pivot
    if (tf.h1.price > tf.h1.pivot) {
      structureScore += 10
      reasons.push('Цена > H1 pivot')
    }
  } else {
    if (tf.h1.marketStructure === 'LH_LL' || tf.h4.marketStructure === 'LH_LL') {
      structureScore += 10
      reasons.push('Структура LH/LL')
    }
    if (tf.h1.adx > 25 && tf.h1.minusDI > tf.h1.plusDI) {
      structureScore += 10
      reasons.push(`H1 ADX ${tf.h1.adx} (trending, -DI>+DI)`)
    } else if (tf.h1.adx > 20) {
      structureScore += 5
    }
    if (tf.h1.price < tf.h1.pivot) {
      structureScore += 10
      reasons.push('Цена < H1 pivot')
    }
  }

  const trendScoreCapped = Math.min(40, trendScore)
  const total = Math.min(100, trendScoreCapped + momentumScore + structureScore)

  return {
    total,
    trend: trendScoreCapped,
    momentum: momentumScore,
    structure: structureScore,
    setupType,
    reasons,
  }
}

export interface ForexLevels {
  entry: number
  stopLoss: number
  takeProfits: { price: number; rr: number }[]
  rr: number // primary R:R (TP1)
}

// Compute entry/SL/TPs from ATR + structure
export function computeForexLevels(
  setupType: 'LONG' | 'SHORT',
  tf: TF,
): ForexLevels {
  const price = tf.h1.price
  const atr = tf.h1.atr || 0.0001 // avoid div-by-zero

  const entry = price

  // Band-clamped structure stop:
  //   far  = max risk (1.5 * ATR)
  //   near = min risk (1.0 * ATR)
  //   structure-based stop with ATR-relative buffer (0.2 * ATR), then clamped into [near, far].
  let stopLoss: number
  if (setupType === 'LONG') {
    const atrStopFar = entry - atr * 1.5  // максимально допустимый риск (дальняя точка)
    const atrStopNear = entry - atr * 1.0 // минимальный риск (ближняя точка)
    const structStop = tf.h1.support - atr * 0.2 // structure-based с ATR-relative буфером

    let sl = structStop
    if (sl > atrStopNear) sl = atrStopNear // структура слишком близко — отодвинуть к near
    if (sl < atrStopFar) sl = atrStopFar   // структура слишком далеко — клампить к far
    stopLoss = sl
  } else {
    const atrStopFar = entry + atr * 1.5
    const atrStopNear = entry + atr * 1.0
    const structStop = tf.h1.resistance + atr * 0.2

    let sl = structStop
    if (sl < atrStopNear) sl = atrStopNear
    if (sl > atrStopFar) sl = atrStopFar
    stopLoss = sl
  }

  const risk = Math.abs(entry - stopLoss)

  // TPs: rr 1.2 / 2.0 / 3.0 (было 1.5 / 2.5 / 4)
  const takeProfits = [1.2, 2.0, 3.0].map((rr) => ({
    price: setupType === 'LONG' ? entry + risk * rr : entry - risk * rr,
    rr,
  }))

  return {
    entry,
    stopLoss,
    takeProfits,
    rr: takeProfits[0].rr,
  }
}
