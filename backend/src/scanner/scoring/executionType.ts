import { MultiTFIndicators } from '../../services/indicators'
import {
  SetupCategory,
  ExecutionType,
  EntryTriggerResult,
  LimitEntryPlan,
  LimitZoneSource,
  MarketEntryPlan,
} from './types'
import { round, fmtPrice } from '../utils/round'
import { calculateImpulseExtension } from './hardFilters'

// === EXECUTION TYPE CLASSIFICATION ===
// Distinguishes setup quality from entry timing / execution quality.
// A setup can be valid while immediate market entry is invalid.

export function selectExecutionType(
  type: 'LONG' | 'SHORT',
  category: SetupCategory,
  entryTrigger: EntryTriggerResult,
  indicators: MultiTFIndicators,
): ExecutionType {
  const isLong = type === 'LONG'
  const { tf15m, tf1h } = indicators
  const price = tf1h.price
  const atr15m = tf15m.atr
  const atr1h = tf1h.atr

  // IGNORE: setup not worth tracking
  if (category === 'IGNORE') return 'IGNORE'

  // WATCHLIST: setup present but weak
  if (category === 'WATCHLIST' && !entryTrigger.passed) return 'WAIT_CONFIRMATION'

  // Check if immediate entry is valid
  const impulseExt = calculateImpulseExtension(price, tf1h.ema20, atr1h)

  // Distance from trigger in ATR(15m)
  const triggerLevel = isLong
    ? Math.max(tf1h.ema20, tf1h.vwap)
    : Math.min(tf1h.ema20, tf1h.vwap)
  const distFromTrigger = atr15m > 0 ? Math.abs(price - triggerLevel) / atr15m : 999

  const canEnterNow =
    (category === 'READY' || category === 'A_PLUS_READY') &&
    entryTrigger.passed &&
    distFromTrigger <= 0.35 &&
    impulseExt <= 0.6

  if (canEnterNow) {
    return isLong ? 'ENTER_NOW_LONG' : 'ENTER_NOW_SHORT'
  }

  // Setup valid but immediate entry too extended or degrades R:R → LIMIT
  const setupValid = category === 'READY' || category === 'A_PLUS_READY'
  if (setupValid && (distFromTrigger > 0.35 || impulseExt > 0.6)) {
    return isLong ? 'LIMIT_LONG' : 'LIMIT_SHORT'
  }

  // Setup valid + trigger not confirmed yet
  if (setupValid && !entryTrigger.passed) {
    return 'WAIT_CONFIRMATION'
  }

  // WATCHLIST with trigger → still limit
  if (category === 'WATCHLIST' && entryTrigger.passed) {
    return isLong ? 'LIMIT_LONG' : 'LIMIT_SHORT'
  }

  return 'WAIT_CONFIRMATION'
}

// Boost weight for zones that have confluence (another zone within 0.3%)
function boostConfluence(zones: { price: number; source: string; weight: number }[], refPrice: number) {
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const dist = Math.abs(zones[i].price - zones[j].price) / refPrice
      if (dist < 0.003) { // within 0.3% — strong confluence
        // Boost the one with higher base weight
        if (zones[i].weight >= zones[j].weight) {
          zones[i].weight += 2
        } else {
          zones[j].weight += 2
        }
      } else if (dist < 0.006) { // within 0.6% — mild confluence
        if (zones[i].weight >= zones[j].weight) {
          zones[i].weight += 1
        } else {
          zones[j].weight += 1
        }
      }
    }
  }
}

// === LIMIT ENTRY PLAN ===
// For LIMIT_LONG and LIMIT_SHORT signals, generates a structured entry plan

export function generateLimitPlan(
  type: 'LONG' | 'SHORT',
  indicators: MultiTFIndicators,
  stopLoss: number,
  takeProfits: { price: number; rr: number }[],
): LimitEntryPlan {
  const { tf1h, tf4h } = indicators
  const isLong = type === 'LONG'
  const price = tf1h.price
  const atr = tf1h.atr

  // Collect zone candidates with confluence weighting
  // Confluence: zones that cluster with other levels get higher weight
  const zones: { price: number; source: LimitZoneSource; weight: number }[] = []

  if (isLong) {
    // EMA20 1H — primary pullback level
    if (tf1h.ema20 < price && tf1h.ema20 > price * 0.95) {
      zones.push({ price: tf1h.ema20, source: 'EMA20_RETEST', weight: 3 })
    }
    // VWAP — fair value
    if (tf1h.vwap < price && tf1h.vwap > price * 0.95) {
      zones.push({ price: tf1h.vwap, source: 'VWAP_RETEST', weight: 3 })
    }
    // Local support from swing lows
    if (tf1h.support < price && tf1h.support > price * 0.93) {
      zones.push({ price: tf1h.support, source: 'LOCAL_SUPPORT', weight: 2 })
    }
    // 50% retracement of latest impulse leg (using swing points when available)
    const recentSwingLow = tf1h.swingLows.length > 0
      ? tf1h.swingLows[tf1h.swingLows.length - 1].price
      : tf1h.support
    const recentSwingHigh = tf1h.swingHighs.length > 0
      ? tf1h.swingHighs[tf1h.swingHighs.length - 1].price
      : price
    const midPullback = (recentSwingLow + recentSwingHigh) / 2
    if (midPullback < price && midPullback > recentSwingLow) {
      zones.push({ price: midPullback, source: 'IMPULSE_50_PULLBACK', weight: 2 })
    }
    // Breakout retest — previous resistance now support
    if (tf4h.support > tf1h.support && tf4h.support < price && tf4h.support > price * 0.95) {
      zones.push({ price: tf4h.support, source: 'BREAKOUT_RETEST', weight: 3 })
    }

    // Confluence bonus: if two zones are within 0.3% of each other, boost the better one
    boostConfluence(zones, price)
  } else {
    // SHORT mirror
    if (tf1h.ema20 > price && tf1h.ema20 < price * 1.05) {
      zones.push({ price: tf1h.ema20, source: 'EMA20_RETEST', weight: 3 })
    }
    if (tf1h.vwap > price && tf1h.vwap < price * 1.05) {
      zones.push({ price: tf1h.vwap, source: 'VWAP_RETEST', weight: 3 })
    }
    if (tf1h.resistance > price && tf1h.resistance < price * 1.07) {
      zones.push({ price: tf1h.resistance, source: 'LOCAL_RESISTANCE', weight: 2 })
    }
    const recentSwingHigh = tf1h.swingHighs.length > 0
      ? tf1h.swingHighs[tf1h.swingHighs.length - 1].price
      : tf1h.resistance
    const recentSwingLow = tf1h.swingLows.length > 0
      ? tf1h.swingLows[tf1h.swingLows.length - 1].price
      : price
    const midBounce = (recentSwingHigh + recentSwingLow) / 2
    if (midBounce > price && midBounce < recentSwingHigh) {
      zones.push({ price: midBounce, source: 'IMPULSE_50_PULLBACK', weight: 2 })
    }
    if (tf4h.resistance < tf1h.resistance && tf4h.resistance > price && tf4h.resistance < price * 1.05) {
      zones.push({ price: tf4h.resistance, source: 'BREAKOUT_RETEST', weight: 3 })
    }

    boostConfluence(zones, price)
  }

  // Sort by weight (descending) and pick best zone
  zones.sort((a, b) => b.weight - a.weight)
  const bestZone = zones[0] || { price: isLong ? price - atr * 0.3 : price + atr * 0.3, source: 'EMA20_RETEST' as LimitZoneSource, weight: 1 }

  // Build zone with ±0.15 ATR spread
  const spread = atr * 0.15
  const entry_zone_low = isLong
    ? round(bestZone.price - spread)
    : round(bestZone.price)
  const entry_zone_high = isLong
    ? round(bestZone.price)
    : round(bestZone.price + spread)
  const preferred_limit_price = round(bestZone.price)

  // Invalidation: below support for LONG, above resistance for SHORT
  const invalidation_price = isLong
    ? round(tf1h.support - atr * 0.3)
    : round(tf1h.resistance + atr * 0.3)

  // Build explanation
  const explanation = isLong
    ? `Лимитный LONG от ${bestZone.source}: зона $${fmtPrice(entry_zone_low)}-$${fmtPrice(entry_zone_high)}. Инвалидация при пробое $${fmtPrice(invalidation_price)}.`
    : `Лимитный SHORT от ${bestZone.source}: зона $${fmtPrice(entry_zone_low)}-$${fmtPrice(entry_zone_high)}. Инвалидация при пробое $${fmtPrice(invalidation_price)}.`

  return {
    entry_zone_low,
    entry_zone_high,
    preferred_limit_price,
    zone_source: bestZone.source,
    invalidation_price,
    tp1_price: takeProfits[0]?.price || 0,
    tp2_price: takeProfits[1]?.price || 0,
    tp3_price: takeProfits[2]?.price || 0,
    ttl_minutes: 240, // 4 hours
    cancel_if_not_triggered: true,
    cancel_if_structure_invalidated: true,
    explanation,
  }
}

// === MARKET ENTRY PLAN ===
// For ENTER_NOW signals, generates an immediate entry plan with chase limits

export function generateMarketPlan(
  type: 'LONG' | 'SHORT',
  indicators: MultiTFIndicators,
  stopLoss: number,
  takeProfits: { price: number; rr: number }[],
): MarketEntryPlan {
  const { tf1h, tf15m } = indicators
  const isLong = type === 'LONG'
  const price = tf1h.price
  const atr15m = tf15m.atr

  // Max chase: 0.35 ATR(15m) beyond current price
  const max_chase_price = isLong
    ? round(price + atr15m * 0.35)
    : round(price - atr15m * 0.35)

  const invalidation_price = stopLoss

  const explanation = isLong
    ? `Рыночный LONG по ~$${fmtPrice(price)}. Макс. цена входа: $${fmtPrice(max_chase_price)}. Стоп: $${fmtPrice(stopLoss)}.`
    : `Рыночный SHORT по ~$${fmtPrice(price)}. Макс. цена входа: $${fmtPrice(max_chase_price)}. Стоп: $${fmtPrice(stopLoss)}.`

  return {
    market_entry_price: round(price),
    max_chase_price,
    invalidation_price,
    tp1_price: takeProfits[0]?.price || 0,
    tp2_price: takeProfits[1]?.price || 0,
    tp3_price: takeProfits[2]?.price || 0,
    explanation,
  }
}

// === AUTO-DOWNGRADE ===
// If current price exceeds max_chase_price, downgrade ENTER_NOW to LIMIT
export function maybeDowngradeExecution(
  execType: ExecutionType,
  marketPlan: MarketEntryPlan | null,
  currentPrice: number,
): ExecutionType {
  if (!marketPlan) return execType
  if (execType === 'ENTER_NOW_LONG' && currentPrice > marketPlan.max_chase_price) {
    return 'LIMIT_LONG'
  }
  if (execType === 'ENTER_NOW_SHORT' && currentPrice < marketPlan.max_chase_price) {
    return 'LIMIT_SHORT'
  }
  return execType
}
