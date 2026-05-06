/**
 * Levels engine v2 — designed to match how a real trader uses levels.
 *
 * Differences from v1:
 *   - Levels are FIXED swing points (Williams fractals: pivot with N bars left & right),
 *     not rolling-window highs. They persist until "exhausted" (broken twice in same dir).
 *   - REACTION fires on a wide TOUCH ZONE (±atr * touchAtrMult) without requiring long wick.
 *   - BREAKOUT_RETEST fires when:
 *       1) bar X closes beyond level (pierce)
 *       2) within retestWindow bars, price comes back to level
 *       3) level holds (price closes back in pierce direction) → entry
 *   - No volume gate, no ATR gate, no HTF EMA filter (caller can add later).
 *
 * Public API:
 *   precomputeLevelsV2(ltf, h1, h4, daily) → returns precomputed level catalog + helpers
 *   generateSignalV2(ltf, i, cfg, pre, state) → optional signal for bar i
 */

import { OHLCV } from '../services/market'

const D1_MS = 24 * 60 * 60_000
const W1_MS = 7 * D1_MS

export type LevelSourceV2 =
  | 'PDH' | 'PDL'
  | 'PWH' | 'PWL'
  | 'FRACTAL_HIGH' | 'FRACTAL_LOW'           // LTF (5m) fractals
  | 'FRACTAL_HIGH_M15' | 'FRACTAL_LOW_M15'   // 15m fractals — stronger swings
  | 'FRACTAL_HIGH_H1' | 'FRACTAL_LOW_H1'     // 1h fractals — strongest swings

export type EventKindV2 = 'REACTION' | 'BREAKOUT_RETEST' | 'RANGE_PLAY'

export interface LevelV2 {
  price: number
  source: LevelSourceV2
  /** Bar index when this level became known (i.e. fractal confirmed). For PDH/PDL: end of prev day. */
  bornIdx: number
  /** Bar index when level became "exhausted" (broken with conviction in both directions). */
  exhaustedIdx: number | null
}

export interface LevelsV2Config {
  // Williams fractals on LTF: a high/low that has N bars with strictly lower-high
  // (or strictly higher-low) on each side.
  fractalLeft: number
  fractalRight: number

  // Optional 15m / 1h fractals — multi-TF level sources (set to 0 to disable).
  fractalLeftM15: number
  fractalRightM15: number
  fractalLeftH1: number
  fractalRightH1: number

  // Touch zone width: anything within `touchAtrMult * ATR(14)` of a level counts as a touch.
  touchAtrMult: number

  // Reaction confirmation: after touch, the bar must close back away from the level by
  // at least `reactionMinReturnAtr * ATR(14)`. This filters momentary pierces that don't reverse.
  reactionMinReturnAtr: number

  // Breakout-retest:
  pierceMinAtr: number       // first bar must close beyond level by ≥ this × ATR
  retestWindow: number       // # of bars to wait for retest after pierce
  retestHoldAtr: number      // retest "holds" if bar closes ≥ this × ATR away in pierce direction

  // SL: nearest opposite-side level + buffer. Fallback = ATR-based.
  slBufferAtr: number
  fallbackSlAtr: number

  /**
   * Min distance (in ATR) of TP1 from entry. If the nearest level in trade direction
   * is closer than this, skip it and use the next level. 0 = disabled (use the
   * nearest level no matter how close). Improves R:R on TP1.
   */
  tpMinAtr: number

  // Cooldown to avoid duplicate signals on same level
  cooldownBars: number

  // Which event types to emit
  allowReaction: boolean
  allowBreakoutRetest: boolean
  allowRangePlay: boolean

  // ---- Range-play parameters ----
  /** Min size of the range in ATR units (skip tight ranges). */
  rangeMinAtr: number
  /** Max size of the range in ATR units (skip wide ranges that aren't really ranges). */
  rangeMaxAtr: number
  /** Min # of bars price has been bouncing inside the range before we trade it. */
  rangeMinBarsInside: number
  /** Lookback (bars) to count "inside" presence. */
  rangeInsideLookback: number
  /** TP fraction of the range distance (0.95 = stop 5% before opposite border). */
  rangeTpFrac: number

  // Which level sources to use
  allowedSources: LevelSourceV2[]

  // Quality gates on fractal levels:
  /** Drop a fractal level if another level (any source) is within this ATR multiple. */
  minSeparationAtr: number
  /** Required # of times the level was approached (within touchAtrMult) before signals can fire on it. */
  minTouchesBeforeSignal: number
  /** Lookback to confirm minTouchesBeforeSignal (in bars). 0 = since birth. */
  touchConfirmLookback: number

  // ---- Fibonacci confluence ----
  /**
   * 'off'   — fibo not used
   * 'filter' — only emit signals whose level is inside fibo zone AND direction matches impulse
   * 'boost' — always emit, just tag isFiboConfluence in the signal so backtester can split metrics
   */
  fiboMode: 'off' | 'filter' | 'boost'
  /** Lookback (LTF bars) to find the last major swing forming the impulse. */
  fiboImpulseLookback: number
  /** Minimum impulse size in ATR units (skip tiny ranges). */
  fiboImpulseMinAtr: number
  /** Fibo zone boundaries (e.g. 0.5..0.618 = standard golden retracement). */
  fiboZoneFrom: number
  fiboZoneTo: number
  /** Tolerance to "be in zone" — fraction of impulse range (e.g. 0.05 = ±5% of range). */
  fiboZoneTolerance: number
}

export const DEFAULT_LEVELS_V2: LevelsV2Config = {
  fractalLeft: 3,
  fractalRight: 3,
  fractalLeftM15: 3,
  fractalRightM15: 3,
  fractalLeftH1: 3,
  fractalRightH1: 3,
  touchAtrMult: 0.4,
  reactionMinReturnAtr: 0.3,
  pierceMinAtr: 0.5,
  retestWindow: 8,
  retestHoldAtr: 0.3,
  slBufferAtr: 0.5,
  fallbackSlAtr: 1.5,
  tpMinAtr: 0,  // 0 = disabled (use nearest level as TP1, even if very close)
  cooldownBars: 4,
  allowReaction: true,
  allowBreakoutRetest: true,
  allowRangePlay: true,
  rangeMinAtr: 2.0,
  rangeMaxAtr: 8.0,
  rangeMinBarsInside: 30,    // ~2.5h on 5m
  rangeInsideLookback: 120,  // ~10h on 5m
  rangeTpFrac: 0.9,
  allowedSources: ['PDH', 'PDL', 'PWH', 'PWL', 'FRACTAL_HIGH', 'FRACTAL_LOW', 'FRACTAL_HIGH_M15', 'FRACTAL_LOW_M15', 'FRACTAL_HIGH_H1', 'FRACTAL_LOW_H1'],
  minSeparationAtr: 0.8,
  minTouchesBeforeSignal: 2,
  touchConfirmLookback: 0,
  fiboMode: 'off',
  fiboImpulseLookback: 200,    // ~17h on 5m
  fiboImpulseMinAtr: 8,         // impulse must be ≥ 8×ATR (real move)
  fiboZoneFrom: 0.45,
  fiboZoneTo: 0.65,
  fiboZoneTolerance: 0.0,       // 0 = exact zone; raise to widen
}

export interface LevelsV2Precomputed {
  atr: number[] // ATR(14), 0 if undefined
  /** All known levels, sorted by bornIdx ascending. */
  levels: LevelV2[]
  /** For each LTF index, list of indices into `levels` that are ACTIVE at that point. */
  activeAt: number[][]
}

export interface SignalV2 {
  side: 'BUY' | 'SELL'
  entryTime: number
  entryPrice: number
  reason: string
  slPrice: number
  tpLadder: number[]
  level: number
  source: LevelSourceV2
  event: EventKindV2
  /** True if this signal's level falls inside the active Fibo zone of the dominant impulse. */
  isFiboConfluence: boolean
  /** Optional impulse info for inspection. */
  fiboImpulse?: { fromPrice: number; toPrice: number; direction: 'BULL' | 'BEAR'; sizeAtr: number }
}

export interface SignalState {
  /** Map from levelKey to last bar idx when we fired on it. */
  lastFiredAt: Map<string, number>
  /** Pending pierces awaiting retest: levelKey → { pierceIdx, side ('BUY' for upward break, 'SELL' for downward) } */
  pendingPierces: Map<string, { pierceIdx: number; pierceSide: 'BUY' | 'SELL'; levelPrice: number; source: LevelSourceV2 }>
}

export function newSignalState(): SignalState {
  return { lastFiredAt: new Map(), pendingPierces: new Map() }
}

export function precomputeLevelsV2(
  ltf: OHLCV[],
  daily: OHLCV[],
  weekly: OHLCV[],
  cfg: LevelsV2Config = DEFAULT_LEVELS_V2,
  m15?: OHLCV[],
  h1?: OHLCV[],
): LevelsV2Precomputed {
  const n = ltf.length
  const atr = atrSeries(ltf, 14)

  // ---- Detect Williams fractals on LTF (FRACTAL_HIGH / FRACTAL_LOW) ----
  const levels: LevelV2[] = []
  const L = cfg.fractalLeft, R = cfg.fractalRight
  for (let i = L; i < n - R; i++) {
    const c = ltf[i]
    let isHigh = true, isLow = true
    for (let k = 1; k <= L; k++) {
      if (ltf[i - k].high >= c.high) isHigh = false
      if (ltf[i - k].low <= c.low) isLow = false
    }
    for (let k = 1; k <= R; k++) {
      if (ltf[i + k].high >= c.high) isHigh = false
      if (ltf[i + k].low <= c.low) isLow = false
    }
    const bornIdx = i + R
    if (isHigh) levels.push({ price: c.high, source: 'FRACTAL_HIGH', bornIdx, exhaustedIdx: null })
    if (isLow) levels.push({ price: c.low, source: 'FRACTAL_LOW', bornIdx, exhaustedIdx: null })
  }

  // ---- 15m fractals → mapped to LTF bornIdx ----
  if (m15 && m15.length > 0 && cfg.fractalLeftM15 > 0 && cfg.fractalRightM15 > 0) {
    const detected = detectFractalsHTF(m15, cfg.fractalLeftM15, cfg.fractalRightM15)
    for (const f of detected) {
      // Map confirmation time of the M15 fractal to the LTF index right after it
      const ltfIdx = mapTimeToIndex(ltf, f.confirmTime)
      if (ltfIdx < 0 || ltfIdx >= n) continue
      levels.push({
        price: f.price,
        source: f.kind === 'high' ? 'FRACTAL_HIGH_M15' : 'FRACTAL_LOW_M15',
        bornIdx: ltfIdx,
        exhaustedIdx: null,
      })
    }
  }

  // ---- 1h fractals ----
  if (h1 && h1.length > 0 && cfg.fractalLeftH1 > 0 && cfg.fractalRightH1 > 0) {
    const detected = detectFractalsHTF(h1, cfg.fractalLeftH1, cfg.fractalRightH1)
    for (const f of detected) {
      const ltfIdx = mapTimeToIndex(ltf, f.confirmTime)
      if (ltfIdx < 0 || ltfIdx >= n) continue
      levels.push({
        price: f.price,
        source: f.kind === 'high' ? 'FRACTAL_HIGH_H1' : 'FRACTAL_LOW_H1',
        bornIdx: ltfIdx,
        exhaustedIdx: null,
      })
    }
  }

  // ---- PDH / PDL — for LTF index i, the most recent CLOSED daily candle ----
  // We add one level entry per day boundary; bornIdx = first LTF bar that falls into the new day.
  if (daily.length > 0) {
    let lastEmittedDailyIdx = -1
    for (let i = 0; i < n; i++) {
      const t = ltf[i].time
      // find the most recent daily candle ending strictly before or at t
      let dIdx = -1
      // naive linear scan ok since daily is small
      for (let d = 0; d < daily.length; d++) {
        if (daily[d].time + D1_MS <= t) dIdx = d
        else break
      }
      if (dIdx > lastEmittedDailyIdx && dIdx >= 0) {
        levels.push({ price: daily[dIdx].high, source: 'PDH', bornIdx: i, exhaustedIdx: null })
        levels.push({ price: daily[dIdx].low,  source: 'PDL', bornIdx: i, exhaustedIdx: null })
        lastEmittedDailyIdx = dIdx
      }
    }
  }

  // ---- PWH / PWL — previous fully-closed week ----
  if (weekly.length > 0) {
    let lastEmittedWeekIdx = -1
    for (let i = 0; i < n; i++) {
      const t = ltf[i].time
      let wIdx = -1
      for (let w = 0; w < weekly.length; w++) {
        if (weekly[w].time + W1_MS <= t) wIdx = w
        else break
      }
      if (wIdx > lastEmittedWeekIdx && wIdx >= 0) {
        levels.push({ price: weekly[wIdx].high, source: 'PWH', bornIdx: i, exhaustedIdx: null })
        levels.push({ price: weekly[wIdx].low,  source: 'PWL', bornIdx: i, exhaustedIdx: null })
        lastEmittedWeekIdx = wIdx
      }
    }
  }

  // Sort by bornIdx
  levels.sort((a, b) => a.bornIdx - b.bornIdx)

  // ---- Mark exhaustion: a level is exhausted once price has CLOSED beyond it on both sides
  //      after birth. We do a forward scan once.
  for (const lvl of levels) {
    let crossedAbove = false, crossedBelow = false
    for (let i = lvl.bornIdx; i < n; i++) {
      const c = ltf[i].close
      if (c > lvl.price) crossedAbove = true
      if (c < lvl.price) crossedBelow = true
      if (crossedAbove && crossedBelow) {
        // Level exhausted at this bar (both sides traded)
        // BUT we want to keep it around for a bit even after exhaustion since pullbacks
        // to recently-pierced levels are tradeable. So we mark with exhaustedIdx = i + 24h
        // Clamped to n-1 so downstream loops never run past the array end (matters for
        // assets with discontinuous trading hours like ETFs).
        const exhaustOffset = Math.round(D1_MS / Math.max(1, ltf[1].time - ltf[0].time))
        lvl.exhaustedIdx = Math.min(n - 1, i + exhaustOffset)
        break
      }
    }
  }

  // ---- Quality filter 1: minimum separation ----
  // For FRACTAL levels, drop those that fall within minSeparationAtr*ATR of an EARLIER, still-active level.
  // PDH/PDL/PWH/PWL always pass (they're structural).
  const sepFiltered: LevelV2[] = []
  for (const lvl of levels) {
    // Structural levels always pass: PDH/PDL/PWH/PWL + HTF fractals (M15/H1)
    if (
      lvl.source === 'PDH' || lvl.source === 'PDL' ||
      lvl.source === 'PWH' || lvl.source === 'PWL' ||
      lvl.source === 'FRACTAL_HIGH_M15' || lvl.source === 'FRACTAL_LOW_M15' ||
      lvl.source === 'FRACTAL_HIGH_H1' || lvl.source === 'FRACTAL_LOW_H1'
    ) {
      sepFiltered.push(lvl)
      continue
    }
    const atrAtBirth = atr[lvl.bornIdx] || 0
    const minSep = atrAtBirth * cfg.minSeparationAtr
    let tooClose = false
    for (const other of sepFiltered) {
      const otherActive = (other.exhaustedIdx === null || other.exhaustedIdx >= lvl.bornIdx)
      if (!otherActive) continue
      if (Math.abs(other.price - lvl.price) < minSep) { tooClose = true; break }
    }
    if (!tooClose) sepFiltered.push(lvl)
  }

  // ---- Quality filter 2: minimum touches before activation ----
  // Walk the LTF and count touches per level. A level only becomes "active" for signaling
  // once it has been approached (within touchAtrMult*ATR) at least minTouchesBeforeSignal times
  // (the birth bar counts as touch 1).
  const activatedAt = new Array<number>(sepFiltered.length).fill(0) // 0 = uses bornIdx
  if (cfg.minTouchesBeforeSignal > 1) {
    for (let li = 0; li < sepFiltered.length; li++) {
      const lvl = sepFiltered[li]
      let touches = 1 // birth = 1
      let activatedIdx = -1
      const lookbackEnd = cfg.touchConfirmLookback > 0
        ? Math.min(n - 1, lvl.bornIdx + cfg.touchConfirmLookback)
        : (lvl.exhaustedIdx ?? n - 1)
      for (let i = lvl.bornIdx + 1; i <= lookbackEnd; i++) {
        const a = atr[i] || 0
        const tol = a * cfg.touchAtrMult
        const c = ltf[i]
        if (c.low <= lvl.price + tol && c.high >= lvl.price - tol) {
          touches++
          if (touches >= cfg.minTouchesBeforeSignal) {
            activatedIdx = i
            break
          }
        }
      }
      activatedAt[li] = activatedIdx >= 0 ? activatedIdx : -1
    }
  } else {
    for (let li = 0; li < sepFiltered.length; li++) activatedAt[li] = sepFiltered[li].bornIdx
  }

  // Keep only levels that ever activated
  const finalLevels: LevelV2[] = []
  for (let li = 0; li < sepFiltered.length; li++) {
    if (activatedAt[li] < 0) continue
    const lvl = { ...sepFiltered[li], bornIdx: activatedAt[li] } // bornIdx = activation bar
    finalLevels.push(lvl)
  }

  // ---- For each bar, list of active level indices ----
  const activeAt: number[][] = new Array(n).fill(null).map(() => [])
  for (let li = 0; li < finalLevels.length; li++) {
    const lvl = finalLevels[li]
    const start = lvl.bornIdx
    const end = lvl.exhaustedIdx ?? n - 1
    for (let i = start; i <= Math.min(end, n - 1); i++) {
      activeAt[i].push(li)
    }
  }

  return { atr, levels: finalLevels, activeAt }
}

/**
 * Find the dominant impulse over the last `lookback` bars ending at index i.
 * Returns null if range is below minAtr*ATR.
 *
 * Bull impulse: minLow happened BEFORE maxHigh in window.
 * Bear impulse: maxHigh happened BEFORE minLow in window.
 *
 * For a tie / mixed pattern, returns the larger leg.
 */
export function findImpulse(
  ltf: OHLCV[],
  i: number,
  lookback: number,
  minAtrMult: number,
  atrAtI: number,
): { fromPrice: number; toPrice: number; direction: 'BULL' | 'BEAR'; sizeAtr: number } | null {
  const start = Math.max(0, i - lookback)
  if (i - start < 5) return null
  let maxHigh = -Infinity, maxIdx = start
  let minLow = Infinity, minIdx = start
  for (let k = start; k <= i; k++) {
    if (ltf[k].high > maxHigh) { maxHigh = ltf[k].high; maxIdx = k }
    if (ltf[k].low < minLow) { minLow = ltf[k].low; minIdx = k }
  }
  const range = maxHigh - minLow
  if (atrAtI <= 0 || range / atrAtI < minAtrMult) return null
  const direction: 'BULL' | 'BEAR' = minIdx < maxIdx ? 'BULL' : 'BEAR'
  return {
    fromPrice: direction === 'BULL' ? minLow : maxHigh,
    toPrice:   direction === 'BULL' ? maxHigh : minLow,
    direction,
    sizeAtr: range / atrAtI,
  }
}

/**
 * Check whether `price` falls inside the Fibo retracement zone [fiboZoneFrom..fiboZoneTo]
 * of the given impulse, AND whether `signalSide` matches the impulse direction
 * (longs only in BULL impulses, shorts only in BEAR).
 *
 * Tolerance widens the zone by `tolerance * impulseRange` on each side.
 */
export function isInFiboZone(
  price: number,
  signalSide: 'BUY' | 'SELL',
  impulse: { fromPrice: number; toPrice: number; direction: 'BULL' | 'BEAR' },
  zoneFrom: number,
  zoneTo: number,
  tolerance: number,
): boolean {
  // Direction must match: BULL impulse → only LONGs (we expect retracement to retest support, then continue up).
  if (impulse.direction === 'BULL' && signalSide !== 'BUY') return false
  if (impulse.direction === 'BEAR' && signalSide !== 'SELL') return false

  const range = Math.abs(impulse.toPrice - impulse.fromPrice)
  if (range <= 0) return false
  // For BULL: retracement = (toPrice - price) / range, where price <= toPrice (i.e. pulled back from peak)
  // For BEAR: retracement = (price - toPrice) / range, where price >= toPrice (pulled back from trough)
  let retr: number
  if (impulse.direction === 'BULL') {
    if (price > impulse.toPrice || price < impulse.fromPrice) return false
    retr = (impulse.toPrice - price) / range
  } else {
    if (price < impulse.toPrice || price > impulse.fromPrice) return false
    retr = (price - impulse.toPrice) / range
  }
  return retr >= zoneFrom - tolerance && retr <= zoneTo + tolerance
}

function buildLadder(
  side: 'BUY' | 'SELL',
  entry: number,
  triggerLevel: number,
  candidates: number[],
  tpMinDistance: number = 0,
): number[] {
  const eps = entry * 0.0001
  const filtered = candidates.filter((p) => Math.abs(p - triggerLevel) > eps)
  // Skip levels too close to entry (TP1 must be at least tpMinDistance away)
  const farEnough = (p: number) => tpMinDistance <= 0 || Math.abs(p - entry) >= tpMinDistance
  if (side === 'BUY') return filtered.filter((p) => p > entry && farEnough(p)).sort((a, b) => a - b)
  return filtered.filter((p) => p < entry && farEnough(p)).sort((a, b) => b - a)
}

function nearestOpposite(side: 'BUY' | 'SELL', triggerLevel: number, candidates: number[]): number | null {
  if (side === 'BUY') {
    const below = candidates.filter((p) => p < triggerLevel)
    return below.length === 0 ? null : Math.max(...below)
  }
  const above = candidates.filter((p) => p > triggerLevel)
  return above.length === 0 ? null : Math.min(...above)
}

export function generateSignalV2(
  ltf: OHLCV[],
  i: number,
  cfg: LevelsV2Config,
  pre: LevelsV2Precomputed,
  state: SignalState,
): SignalV2 | null {
  if (i < 5) return null
  const cur = ltf[i]
  const prev = ltf[i - 1]
  const t = cur.time
  const atr = pre.atr[i]
  if (!isFinite(atr) || atr <= 0) return null

  const allowedSet = new Set(cfg.allowedSources)
  const activeIdxs = pre.activeAt[i] ?? []
  if (activeIdxs.length === 0) return null

  // All active level prices (deduplicated, rounded to 2 decimals)
  const priceSet = new Map<string, { price: number; source: LevelSourceV2 }>()
  for (const li of activeIdxs) {
    const lvl = pre.levels[li]
    if (!allowedSet.has(lvl.source)) continue
    const k = lvl.price.toFixed(2)
    if (!priceSet.has(k)) priceSet.set(k, { price: lvl.price, source: lvl.source })
  }
  const allPrices = [...priceSet.values()].map((v) => v.price)

  // ---- Compute Fibo impulse once per bar ----
  const impulse = cfg.fiboMode !== 'off'
    ? findImpulse(ltf, i, cfg.fiboImpulseLookback, cfg.fiboImpulseMinAtr, atr)
    : null

  const fiboCheck = (side: 'BUY' | 'SELL', triggerPrice: number): boolean => {
    if (cfg.fiboMode === 'off' || !impulse) return false
    return isInFiboZone(triggerPrice, side, impulse, cfg.fiboZoneFrom, cfg.fiboZoneTo, cfg.fiboZoneTolerance)
  }

  // In 'filter' mode, signal must satisfy fibo to be emitted at all.
  // In 'boost' mode, we just tag.
  const fiboPassesFilter = (side: 'BUY' | 'SELL', triggerPrice: number): boolean => {
    if (cfg.fiboMode !== 'filter') return true
    return fiboCheck(side, triggerPrice)
  }

  const slFor = (side: 'BUY' | 'SELL', triggerLevel: number): number => {
    const opp = nearestOpposite(side, triggerLevel, allPrices)
    const buf = atr * cfg.slBufferAtr
    if (opp !== null) return side === 'BUY' ? opp - buf : opp + buf
    return side === 'BUY' ? triggerLevel - atr * cfg.fallbackSlAtr : triggerLevel + atr * cfg.fallbackSlAtr
  }

  // ============== 1. Process pending pierces (BREAKOUT_RETEST) ==============
  if (cfg.allowBreakoutRetest) {
    const toRemove: string[] = []
    for (const [key, p] of state.pendingPierces) {
      if (i - p.pierceIdx > cfg.retestWindow) { toRemove.push(key); continue }
      const tol = atr * cfg.touchAtrMult
      const touched = cur.low <= p.levelPrice + tol && cur.high >= p.levelPrice - tol
      if (!touched) continue

      // Did the bar HOLD the pierce direction?
      // BUY pierce (close above level) → retest holds if cur.close > level + retestHoldAtr*atr
      // SELL pierce (close below level) → retest holds if cur.close < level - retestHoldAtr*atr
      const holdDist = atr * cfg.retestHoldAtr
      const holds = p.pierceSide === 'BUY'
        ? cur.close > p.levelPrice + holdDist
        : cur.close < p.levelPrice - holdDist
      if (!holds) continue

      // Last-fired throttle
      const last = state.lastFiredAt.get(key)
      if (last !== undefined && i - last < cfg.cooldownBars) { toRemove.push(key); continue }

      const sl = slFor(p.pierceSide, p.levelPrice)
      const tpLadder = buildLadder(p.pierceSide, cur.close, p.levelPrice, allPrices, atr * cfg.tpMinAtr)
      const validLadder = tpLadder.length > 0
      // If no ladder (extreme — broke last known level), use ATR target
      const ladder = validLadder ? tpLadder
        : [p.pierceSide === 'BUY' ? cur.close + atr * 2 : cur.close - atr * 2]

      if ((p.pierceSide === 'BUY' && sl < cur.close) || (p.pierceSide === 'SELL' && sl > cur.close)) {
        if (!fiboPassesFilter(p.pierceSide, p.levelPrice)) continue
        const isFibo = fiboCheck(p.pierceSide, p.levelPrice)
        state.lastFiredAt.set(key, i)
        toRemove.push(key)
        return {
          side: p.pierceSide,
          entryTime: t, entryPrice: cur.close,
          reason: `BREAKOUT_RETEST ${p.pierceSide} @ ${p.source} ${p.levelPrice.toFixed(2)} (retest +${i - p.pierceIdx} bars${isFibo ? ', FIBO' : ''})`,
          slPrice: sl,
          tpLadder: ladder,
          level: p.levelPrice,
          source: p.source,
          event: 'BREAKOUT_RETEST',
          isFiboConfluence: isFibo,
          fiboImpulse: impulse ?? undefined,
        }
      }
    }
    for (const k of toRemove) state.pendingPierces.delete(k)

    // Detect NEW pierce on this bar (close beyond an active level by ≥ pierceMinAtr*ATR)
    // and that prior bar was on the OTHER side (so we know it's a fresh pierce)
    for (const li of activeIdxs) {
      const lvl = pre.levels[li]
      if (!allowedSet.has(lvl.source)) continue
      const dist = atr * cfg.pierceMinAtr
      const closeAbove = cur.close > lvl.price + dist
      const closeBelow = cur.close < lvl.price - dist
      const prevWasAbove = prev.close > lvl.price
      const prevWasBelow = prev.close < lvl.price
      if (closeAbove && prevWasBelow) {
        const key = `BR:${lvl.source}:${lvl.price.toFixed(2)}`
        if (!state.pendingPierces.has(key)) {
          state.pendingPierces.set(key, { pierceIdx: i, pierceSide: 'BUY', levelPrice: lvl.price, source: lvl.source })
        }
      } else if (closeBelow && prevWasAbove) {
        const key = `BR:${lvl.source}:${lvl.price.toFixed(2)}`
        if (!state.pendingPierces.has(key)) {
          state.pendingPierces.set(key, { pierceIdx: i, pierceSide: 'SELL', levelPrice: lvl.price, source: lvl.source })
        }
      }
    }
  }

  // ============== 1.5 RANGE_PLAY ==============
  // If price has been bouncing between two near-by active levels for a while, trade
  // off either border toward the opposite one.
  if (cfg.allowRangePlay) {
    // Find nearest active level above and below cur.close
    let upper: { price: number; source: LevelSourceV2 } | null = null
    let lower: { price: number; source: LevelSourceV2 } | null = null
    for (const li of activeIdxs) {
      const lvl = pre.levels[li]
      if (!allowedSet.has(lvl.source)) continue
      if (lvl.price > cur.close) {
        if (upper === null || lvl.price < upper.price) upper = { price: lvl.price, source: lvl.source }
      } else if (lvl.price < cur.close) {
        if (lower === null || lvl.price > lower.price) lower = { price: lvl.price, source: lvl.source }
      }
    }
    if (upper && lower) {
      const rangeWidth = upper.price - lower.price
      const widthAtr = rangeWidth / atr
      if (widthAtr >= cfg.rangeMinAtr && widthAtr <= cfg.rangeMaxAtr) {
        // Count how many of the last `rangeInsideLookback` bars were inside [lower, upper]
        let inside = 0
        const start = Math.max(0, i - cfg.rangeInsideLookback)
        for (let k = start; k < i; k++) {
          if (ltf[k].close >= lower.price && ltf[k].close <= upper.price) inside++
        }
        if (inside >= cfg.rangeMinBarsInside) {
          const tol = atr * cfg.touchAtrMult
          const minReturn = atr * cfg.reactionMinReturnAtr
          // SHORT range-play: bar high tagged upper, close back below upper - minReturn
          const touchedUpper = cur.high >= upper.price - tol && cur.close <= upper.price - minReturn
          if (touchedUpper) {
            const key = `RP:${upper.source}:${upper.price.toFixed(2)}`
            const last = state.lastFiredAt.get(key)
            if (last === undefined || i - last >= cfg.cooldownBars) {
              if (fiboPassesFilter('SELL', upper.price)) {
                const sl = upper.price + atr * cfg.slBufferAtr
                if (sl > cur.close) {
                  const isFibo = fiboCheck('SELL', upper.price)
                  // Single-target TP: opposite border (with slight buffer)
                  const tp = lower.price + rangeWidth * (1 - cfg.rangeTpFrac)
                  state.lastFiredAt.set(key, i)
                  return {
                    side: 'SELL', entryTime: t, entryPrice: cur.close,
                    reason: `RANGE_PLAY SHORT @ ${upper.source} ${upper.price.toFixed(2)} → ${lower.source} ${lower.price.toFixed(2)} (range ${widthAtr.toFixed(1)}×ATR, inside ${inside}/${cfg.rangeInsideLookback}${isFibo ? ', FIBO' : ''})`,
                    slPrice: sl,
                    tpLadder: [tp],
                    level: upper.price,
                    source: upper.source,
                    event: 'RANGE_PLAY',
                    isFiboConfluence: isFibo,
                    fiboImpulse: impulse ?? undefined,
                  }
                }
              }
            }
          }
          // LONG range-play: bar low tagged lower, close back above lower + minReturn
          const touchedLower = cur.low <= lower.price + tol && cur.close >= lower.price + minReturn
          if (touchedLower) {
            const key = `RP:${lower.source}:${lower.price.toFixed(2)}`
            const last = state.lastFiredAt.get(key)
            if (last === undefined || i - last >= cfg.cooldownBars) {
              if (fiboPassesFilter('BUY', lower.price)) {
                const sl = lower.price - atr * cfg.slBufferAtr
                if (sl < cur.close) {
                  const isFibo = fiboCheck('BUY', lower.price)
                  const tp = upper.price - rangeWidth * (1 - cfg.rangeTpFrac)
                  state.lastFiredAt.set(key, i)
                  return {
                    side: 'BUY', entryTime: t, entryPrice: cur.close,
                    reason: `RANGE_PLAY LONG @ ${lower.source} ${lower.price.toFixed(2)} → ${upper.source} ${upper.price.toFixed(2)} (range ${widthAtr.toFixed(1)}×ATR, inside ${inside}/${cfg.rangeInsideLookback}${isFibo ? ', FIBO' : ''})`,
                    slPrice: sl,
                    tpLadder: [tp],
                    level: lower.price,
                    source: lower.source,
                    event: 'RANGE_PLAY',
                    isFiboConfluence: isFibo,
                    fiboImpulse: impulse ?? undefined,
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // ============== 2. REACTION ==============
  if (cfg.allowReaction) {
    const tol = atr * cfg.touchAtrMult
    const minReturn = atr * cfg.reactionMinReturnAtr

    for (const li of activeIdxs) {
      const lvl = pre.levels[li]
      if (!allowedSet.has(lvl.source)) continue

      const key = `R:${lvl.source}:${lvl.price.toFixed(2)}`
      const last = state.lastFiredAt.get(key)
      if (last !== undefined && i - last < cfg.cooldownBars) continue

      // SHORT reaction: bar's high tagged or pierced a level from BELOW, but close came back below.
      // We require: high >= level - tol  AND  close <= level - minReturn  AND  prev close was below level
      if (cur.high >= lvl.price - tol && cur.close <= lvl.price - minReturn && prev.close < lvl.price + tol) {
        if (!fiboPassesFilter('SELL', lvl.price)) continue
        const sl = slFor('SELL', lvl.price)
        const tpLadder = buildLadder('SELL', cur.close, lvl.price, allPrices, atr * cfg.tpMinAtr)
        if (sl > cur.close && tpLadder.length > 0) {
          const isFibo = fiboCheck('SELL', lvl.price)
          state.lastFiredAt.set(key, i)
          return {
            side: 'SELL', entryTime: t, entryPrice: cur.close,
            reason: `REACTION SHORT @ ${lvl.source} ${lvl.price.toFixed(2)} (high ${cur.high.toFixed(2)} → close ${cur.close.toFixed(2)}${isFibo ? ', FIBO' : ''})`,
            slPrice: sl, tpLadder, level: lvl.price, source: lvl.source, event: 'REACTION',
            isFiboConfluence: isFibo,
            fiboImpulse: impulse ?? undefined,
          }
        }
      }
      // LONG reaction: low tagged level from ABOVE, close back above
      if (cur.low <= lvl.price + tol && cur.close >= lvl.price + minReturn && prev.close > lvl.price - tol) {
        if (!fiboPassesFilter('BUY', lvl.price)) continue
        const sl = slFor('BUY', lvl.price)
        const tpLadder = buildLadder('BUY', cur.close, lvl.price, allPrices, atr * cfg.tpMinAtr)
        if (sl < cur.close && tpLadder.length > 0) {
          const isFibo = fiboCheck('BUY', lvl.price)
          state.lastFiredAt.set(key, i)
          return {
            side: 'BUY', entryTime: t, entryPrice: cur.close,
            reason: `REACTION LONG @ ${lvl.source} ${lvl.price.toFixed(2)} (low ${cur.low.toFixed(2)} → close ${cur.close.toFixed(2)}${isFibo ? ', FIBO' : ''})`,
            slPrice: sl, tpLadder, level: lvl.price, source: lvl.source, event: 'REACTION',
            isFiboConfluence: isFibo,
            fiboImpulse: impulse ?? undefined,
          }
        }
      }
    }
  }

  return null
}

// ===== ATR helper =====

function atrSeries(c: OHLCV[], period: number): number[] {
  const out = new Array<number>(c.length).fill(0)
  if (c.length <= period) return out
  let sum = 0
  for (let i = 1; i <= period; i++) {
    const prev = c[i - 1].close
    sum += Math.max(c[i].high - c[i].low, Math.abs(c[i].high - prev), Math.abs(c[i].low - prev))
  }
  let p = sum / period
  out[period] = p
  for (let i = period + 1; i < c.length; i++) {
    const prev = c[i - 1].close
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - prev), Math.abs(c[i].low - prev))
    p = (p * (period - 1) + tr) / period
    out[i] = p
  }
  return out
}

/**
 * Aggregate daily candles into ISO weeks (Mon-Sun) for PWH/PWL.
 * Reused from v1 caller.
 */
export function aggregateDailyToWeekly(daily: OHLCV[]): OHLCV[] {
  if (daily.length === 0) return []
  const out: OHLCV[] = []
  const weekMs = W1_MS
  const firstDay = new Date(daily[0].time)
  const dow = firstDay.getUTCDay()
  const daysFromMon = (dow + 6) % 7
  let weekStart = Date.UTC(firstDay.getUTCFullYear(), firstDay.getUTCMonth(), firstDay.getUTCDate() - daysFromMon)
  while (weekStart <= daily[daily.length - 1].time) {
    const weekEnd = weekStart + weekMs
    let hi = -Infinity, lo = Infinity, op = 0, cl = 0, vol = 0, hadAny = false
    for (const c of daily) {
      if (c.time >= weekStart && c.time < weekEnd) {
        if (!hadAny) op = c.open
        cl = c.close
        if (c.high > hi) hi = c.high
        if (c.low < lo) lo = c.low
        vol += c.volume
        hadAny = true
      }
    }
    if (hadAny) out.push({ time: weekStart, open: op, high: hi, low: lo, close: cl, volume: vol })
    weekStart = weekEnd
  }
  return out
}

// ===== Helpers for multi-TF fractals =====

interface DetectedFractal {
  price: number
  kind: 'high' | 'low'
  /** time of the bar AT WHICH the fractal is confirmed (= pivot time + R bars). */
  confirmTime: number
}

function detectFractalsHTF(candles: OHLCV[], L: number, R: number): DetectedFractal[] {
  const out: DetectedFractal[] = []
  for (let i = L; i < candles.length - R; i++) {
    const c = candles[i]
    let isHigh = true, isLow = true
    for (let k = 1; k <= L; k++) {
      if (candles[i - k].high >= c.high) isHigh = false
      if (candles[i - k].low <= c.low) isLow = false
    }
    for (let k = 1; k <= R; k++) {
      if (candles[i + k].high >= c.high) isHigh = false
      if (candles[i + k].low <= c.low) isLow = false
    }
    if (isHigh) out.push({ price: c.high, kind: 'high', confirmTime: candles[i + R].time })
    if (isLow) out.push({ price: c.low, kind: 'low', confirmTime: candles[i + R].time })
  }
  return out
}

/** Returns the LTF index whose time is >= t. Returns -1 if t is past last bar. */
function mapTimeToIndex(ltf: OHLCV[], t: number): number {
  // Binary search
  let lo = 0, hi = ltf.length - 1, ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (ltf[mid].time >= t) { ans = mid; hi = mid - 1 }
    else lo = mid + 1
  }
  return ans
}

