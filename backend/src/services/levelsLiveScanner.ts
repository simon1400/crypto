/**
 * Levels Live Scanner — production runner for the V2 levels strategy.
 *
 * Every cron tick (default 5 min):
 *   1) For each enabled symbol+side:
 *      - Pull recent candles (5m + 15m + 1h + 1d) from the right source
 *      - Run precomputeLevelsV2 + generateSignalV2 on the LATEST closed bar
 *      - If a signal fires AND there's no recent duplicate on same level → save + notify
 *
 * Dedupe: if a NEW/ACTIVE signal already exists for same symbol/level/side
 *         within the last 1h, skip.
 *
 * Live tracking is handled separately by levelsTracker.ts.
 */

import { prisma } from '../db/prisma'
import { OHLCV } from './market'
import { loadHistorical } from '../scalper/historicalLoader'
import {
  precomputeLevelsV2, generateSignalV2, newSignalState, aggregateDailyToWeekly,
  DEFAULT_LEVELS_V2, LevelsV2Config, SignalV2,
  findImpulse, isInFiboZone, buildLadder, nearestOpposite, passesRRFilter,
  killzoneOf,
} from '../scalper/levelsEngine2'
import { sendNotification } from './notifier'

// === Per-symbol production config (positive-EV combos from backtest) ===
// side: 'BUY' = LONG-only, 'SELL' = SHORT-only, 'BOTH' = trade both directions
type AllowedSide = 'BUY' | 'SELL' | 'BOTH'

type EntryMode = 'MARKET' | 'LIMIT'

interface SymbolSetup {
  symbol: string
  market: 'CRYPTO'
  side: AllowedSide
  fractalLR: 3 | 5
  /**
   * Override for tpMinAtr — minimum distance of TP1 from entry (in ATR units).
   * Skip levels too close to entry. 0 or undefined = use closest level (baseline).
   * Per-setup tuned via 365d sweep backtest (2026-05-06).
   */
  tpMinAtr?: number
  /**
   * Entry mode:
   *   'MARKET' (default) — wait for reaction-confirmation 5m close, enter at close.
   *   'LIMIT' — place limit at level, fill on touch within 1h, confirm on next close.
   * Per-setup decision via walk-forward backtest (2026-05-06): only SOL/ARB had stable LIMIT edge.
   */
  entryMode?: EntryMode
}

// Default setups — based on 365d backtest across 25+ symbols (2026-05-06).
//
// 365d backtest results (V2 levels, ladder 50/30/20, fees crypto 0.08%):
// CRYPTO SHORTs (alt-bear regime 2025–2026):
//   XRPUSDT SELL: 48 trades, +91.5R, +1.91 R/tr, WR 48%, PF 5.28 ★★★
//   SEIUSDT SELL: 29 trades, +24.7R, +0.85 R/tr, WR 41%, PF 2.39 ★
//   WIFUSDT SELL: 35 trades, +25.6R, +0.73 R/tr, WR 49%, PF 2.43 ★
//   SOLUSDT SELL: 135 trades, +92.5R, +0.69 R/tr, WR 47%, PF 2.93 ★
//   ARBUSDT SELL: 57 trades, +33.4R, +0.59 R/tr, WR 58%, PF 2.39 ✅
//   AVAXUSDT SELL: 176 trades, +81.7R, +0.46 R/tr, WR 45%, PF 2.11 ✅
//   1000PEPEUSDT SELL: 48 trades, +20.7R, +0.43 R/tr, WR 81%, PF 3.30 ✅
//   ETHUSDT SELL: 196 trades, +59.5R, +0.30 R/tr, WR 40%, PF 1.58 ✅
// CRYPTO LONG / BOTH:
//   HYPEUSDT BUY: 80 trades, +60.6R, +0.76 R/tr, WR 40%, PF 2.62 ★ (единственный bullish-режим алт)
//   ENAUSDT BOTH: 36 trades, +65.7R, +1.82 R/tr, WR 58%, PF 5.20 ★
// Rejected: TON/NEAR/APT/SUI/BCH/LTC/DOGE/BNB/LINK/ADA/DOT/TRUMP/BONK any side,
//           1000FLOKI BUY (WR 14% — лотерея, нестабильно).
// Statistical tail (<25 trades): NEAR/APT/TIA SELL — выглядят жирно, но выборка мала.
// XAGUSD / SHIBUSDT — недоступны (платный TwelveData / Bybit формат).
export const DEFAULT_SETUPS: SymbolSetup[] = [
  // Crypto majors
  { symbol: 'BTCUSDT',      market: 'CRYPTO', side: 'BOTH', fractalLR: 3, tpMinAtr: 1.5 }, // 90d +19R; sweep +35R @ 1.5
  // Crypto SHORTs (alt-bear regime 2025-2026) with per-setup tpMinAtr from sweep
  { symbol: 'XRPUSDT',      market: 'CRYPTO', side: 'SELL', fractalLR: 3, tpMinAtr: 1.0 }, // +1.91 → +2.55 R/tr (sweep +9R)
  { symbol: 'SEIUSDT',      market: 'CRYPTO', side: 'SELL', fractalLR: 3 },                // baseline best (+0.85)
  { symbol: 'WIFUSDT',      market: 'CRYPTO', side: 'SELL', fractalLR: 3, tpMinAtr: 2.0 }, // +0.73 → +1.17 R/tr (sweep +45R)
  // SOL & ARB: walk-forward validated LIMIT edge (2026-05-06).
  //   SOL: TRAIN +1.17→+4.23 R/tr, TEST +0.07→+0.33 R/tr (LIMIT wins both periods).
  //   ARB: TRAIN +0.58→+1.07 R/tr, TEST +0.41→+1.53 R/tr (LIMIT wins both periods).
  // All other setups (XRP/SEI/WIF/AVAX/PEPE/ETH/HYPE/ENA/BTC) had unstable LIMIT edge in walk-forward,
  // so they default to MARKET.
  { symbol: 'SOLUSDT',      market: 'CRYPTO', side: 'SELL', fractalLR: 3, tpMinAtr: 1.0, entryMode: 'LIMIT' },
  { symbol: 'ARBUSDT',      market: 'CRYPTO', side: 'SELL', fractalLR: 3,                entryMode: 'LIMIT' },
  { symbol: 'AVAXUSDT',     market: 'CRYPTO', side: 'SELL', fractalLR: 3, tpMinAtr: 1.0 }, // +0.46 → +0.73 R/tr (sweep +14R)
  { symbol: '1000PEPEUSDT', market: 'CRYPTO', side: 'SELL', fractalLR: 3 },                // baseline (no diff)
  { symbol: 'ETHUSDT',      market: 'CRYPTO', side: 'SELL', fractalLR: 3 },                // baseline only — sweep ломает edge
  // Crypto LONG / BOTH outliers
  { symbol: 'HYPEUSDT',     market: 'CRYPTO', side: 'BUY',  fractalLR: 3, tpMinAtr: 0.5 }, // +0.74 → +0.71 R/tr, WR 40→52%
  { symbol: 'ENAUSDT',      market: 'CRYPTO', side: 'BOTH', fractalLR: 3, tpMinAtr: 1.5 }, // +1.86 → +2.11 R/tr (sweep +0.4R)
  // === Round 5 additions (2026-05-06) — 365d backtest of 20 new altcoins, walk-forward validated ===
  // Out of 60 combos (20 sym × 3 sides), 8 passed PASS criteria, 5 stable in walk-forward,
  // tpMinAtr swept per symbol. Final 4 added (AAVE BOTH dropped — duplicates SELL).
  { symbol: 'AAVEUSDT',     market: 'CRYPTO', side: 'SELL', fractalLR: 3, tpMinAtr: 1.5 }, // ★★★ +2.19 R/tr (139 trades, +304R/yr) — tpMinAtr sweep gives +1.44 vs baseline
  { symbol: 'STRKUSDT',     market: 'CRYPTO', side: 'SELL', fractalLR: 3 },                // +0.47 R/tr (56 trades, WR 68%)
  { symbol: 'BLURUSDT',     market: 'CRYPTO', side: 'SELL', fractalLR: 3 },                // +0.39 R/tr (36 trades, WR 58%)
  { symbol: 'CRVUSDT',      market: 'CRYPTO', side: 'SELL', fractalLR: 3, tpMinAtr: 0.5 }, // +0.44 R/tr (74 trades) — sweep slightly improves
]

const DEDUP_WINDOW_MS = 60 * 60_000 // 1h: don't fire 2 signals on same level within 1h
const SYMBOL_DEDUP_WINDOW_MS = 30 * 60_000 // 30min: don't fire 2 signals on same symbol+side (any level) — prevents stacking 3+ entries on the same coin in one cycle

function buildCfg(
  fractalLR: 3 | 5,
  tpMinAtr: number = 0,
): LevelsV2Config {
  return {
    ...DEFAULT_LEVELS_V2,
    fractalLeft: fractalLR, fractalRight: fractalLR,
    fractalLeftM15: 3, fractalRightM15: 3,
    fractalLeftH1: 3, fractalRightH1: 3,
    minSeparationAtr: 0.8, minTouchesBeforeSignal: 2,
    cooldownBars: 12,
    allowRangePlay: false,
    fiboMode: 'filter',
    fiboZoneFrom: 0.5,
    fiboZoneTo:   0.618,
    fiboImpulseLookback: 100,
    fiboImpulseMinAtr: 8,
    tpMinAtr,
    // R:R guard: reject lottery setups where SL is too tight vs TP1 (>8R = SEI case
    // 2026-05-06 with SL 0.6% and TP1 9%). minRR is DISABLED (sweep 2026-05-06 showed
    // it removes profitable setups: R/tr drops from +1.09 to +0.64).
    minRR: 0,
    maxRR: 8,
    // Killzone filter: exclude NY_PM (15-17 UTC) — only consistently negative session
    // per 365d backtest 2026-05-06 (R/tr -0.10, totalR -6 across 58 trades).
    excludeKillzones: ['NY_PM'],
  }
}

async function loadCandles(setup: SymbolSetup): Promise<{ m5: OHLCV[]; m15: OHLCV[]; h1: OHLCV[]; d1: OHLCV[] }> {
  const m5  = await loadHistorical(setup.symbol, '5m',  1, 'bybit', 'linear')
  const m15 = await loadHistorical(setup.symbol, '15m', 1, 'bybit', 'linear')
  const h1  = await loadHistorical(setup.symbol, '1h',  1, 'bybit', 'linear')
  const d1  = await loadHistorical(setup.symbol, '1d',  3, 'bybit', 'linear')
  return { m5, m15, h1, d1 }
}

async function dedupHit(symbol: string, side: 'BUY' | 'SELL', level: number): Promise<boolean> {
  const since = new Date(Date.now() - DEDUP_WINDOW_MS)
  const eps = level * 0.0005 // 0.05% tolerance
  const existing = await prisma.levelsSignal.findFirst({
    where: {
      symbol,
      side,
      createdAt: { gte: since },
      level: { gte: level - eps, lte: level + eps },
      status: { in: ['NEW', 'ACTIVE', 'TP1_HIT', 'TP2_HIT', 'PENDING', 'AWAITING_CONFIRM'] },
    },
  })
  return !!existing
}

/**
 * Per-symbol dedup (any level): blocks stacking multiple signals on the same
 * symbol+side within 30 minutes. Prevents the 22:11 AAVE×2+AVAX×1 case where
 * three close fractals fired in the same scan cycle, tripling user's risk
 * exposure on what is effectively the same trade idea.
 */
async function symbolDedupHit(symbol: string, side: 'BUY' | 'SELL'): Promise<boolean> {
  const since = new Date(Date.now() - SYMBOL_DEDUP_WINDOW_MS)
  const existing = await prisma.levelsSignal.findFirst({
    where: {
      symbol,
      side,
      createdAt: { gte: since },
      status: { in: ['NEW', 'ACTIVE', 'TP1_HIT', 'TP2_HIT', 'PENDING', 'AWAITING_CONFIRM'] },
    },
  })
  return !!existing
}

/** Same dedup but checks active PENDING signal on the exact level for LIMIT mode (longer window). */
async function pendingDedupHit(symbol: string, side: 'BUY' | 'SELL', level: number): Promise<boolean> {
  const eps = level * 0.0005
  const existing = await prisma.levelsSignal.findFirst({
    where: {
      symbol,
      side,
      level: { gte: level - eps, lte: level + eps },
      status: { in: ['PENDING', 'AWAITING_CONFIRM', 'ACTIVE', 'TP1_HIT', 'TP2_HIT'] },
    },
  })
  return !!existing
}

async function saveAndNotify(setup: SymbolSetup, sig: SignalV2, expiryHours: number): Promise<void> {
  const expiresAt = new Date(Date.now() + expiryHours * 60 * 60_000)

  const created = await prisma.levelsSignal.create({
    data: {
      symbol: setup.symbol,
      market: setup.market,
      side: sig.side,
      event: sig.event,
      source: sig.source,
      level: sig.level,
      entryPrice: sig.entryPrice,
      stopLoss: sig.slPrice,
      initialStop: sig.slPrice,
      currentStop: sig.slPrice,
      tpLadder: sig.tpLadder,
      isFiboConfluence: sig.isFiboConfluence,
      fiboImpulse: sig.fiboImpulse ? (sig.fiboImpulse as any) : undefined,
      reason: sig.reason,
      status: 'NEW',
      expiresAt,
    },
  })

  // Telegram notification — include position sizing if paper trading is configured
  let depositUsd: number | undefined
  let riskPctPerTrade: number | undefined
  try {
    const paperCfg = await prisma.levelsPaperConfig.findUnique({ where: { id: 1 } })
    if (paperCfg) {
      depositUsd = paperCfg.currentDepositUsd
      riskPctPerTrade = paperCfg.riskPctPerTrade
    }
  } catch {
    // Paper config table may not exist yet — that's ok, just skip sizing block
  }

  try {
    await sendNotification('LEVELS_NEW' as any, {
      id: created.id,
      symbol: setup.symbol,
      market: setup.market,
      side: sig.side,
      event: sig.event,
      source: sig.source,
      level: sig.level,
      entryPrice: sig.entryPrice,
      stopLoss: sig.slPrice,
      tpLadder: sig.tpLadder,
      isFibo: sig.isFiboConfluence,
      reason: sig.reason,
      depositUsd,
      riskPctPerTrade,
    })
    await prisma.levelsSignal.update({
      where: { id: created.id },
      data: { notifiedTelegram: true },
    })
  } catch (e: any) {
    console.error('[LevelsScanner] notify failed:', e.message)
  }

  console.log(`[LevelsScanner] NEW ${setup.symbol} ${sig.side} ${sig.event} @ ${sig.source} ${sig.level.toFixed(2)} (id=${created.id})`)
}

/** LIMIT-mode parameters (1h fill window, ~15min of confirm window after fill). */
export const PENDING_VALID_HOURS = 1   // 12 × 5m bars = 1h
export const CONFIRM_WINDOW_BARS = 3   // 3 × 5m bars = 15min after fill

/**
 * For LIMIT-mode setups: scan active levels in current Fibo zone, create PENDING signals
 * for any level not already pending. Returns number of PENDING signals created.
 */
async function scanLimitPending(setup: SymbolSetup, m5: OHLCV[], m15: OHLCV[], h1: OHLCV[], d1: OHLCV[], cfg: LevelsV2Config, expiryHours: number): Promise<number> {
  const w1 = aggregateDailyToWeekly(d1)
  const pre = precomputeLevelsV2(m5, d1, w1, cfg, m15, h1)
  const lastIdx = m5.length - 1
  const cur = m5[lastIdx]
  const atr = pre.atr[lastIdx]
  if (!isFinite(atr) || atr <= 0) return 0

  // Killzone filter — same as in generateSignalV2 (e.g. skip NY_PM where R/tr is negative)
  if (cfg.excludeKillzones && cfg.excludeKillzones.length > 0) {
    if (cfg.excludeKillzones.includes(killzoneOf(cur.time))) return 0
  }

  const activeIdxs = pre.activeAt[lastIdx] ?? []
  if (activeIdxs.length === 0) return 0
  const allowedSet = new Set(cfg.allowedSources)
  const impulse = findImpulse(m5, lastIdx, cfg.fiboImpulseLookback, cfg.fiboImpulseMinAtr, atr)
  if (!impulse) return 0

  const allowedSides: Array<'BUY' | 'SELL'> = setup.side === 'BOTH' ? ['BUY', 'SELL']
    : setup.side === 'BUY' ? ['BUY'] : ['SELL']

  // All active level prices (for SL/TP computation)
  const priceSet = new Map<string, number>()
  for (const li of activeIdxs) {
    const lvl = pre.levels[li]
    if (!allowedSet.has(lvl.source)) continue
    priceSet.set(lvl.price.toFixed(8), lvl.price)
  }
  const allPrices = [...priceSet.values()]

  let created = 0
  for (const li of activeIdxs) {
    const lvl = pre.levels[li]
    if (!allowedSet.has(lvl.source)) continue
    for (const side of allowedSides) {
      // Must be in fibo zone for matching impulse direction
      if (!isInFiboZone(lvl.price, side, impulse, cfg.fiboZoneFrom, cfg.fiboZoneTo, 0)) continue
      // BUY limits below current, SELL above
      if (side === 'BUY' && lvl.price >= cur.close) continue
      if (side === 'SELL' && lvl.price <= cur.close) continue

      // Skip if already pending/active for this level
      if (await pendingDedupHit(setup.symbol, side, lvl.price)) continue
      // Skip if any signal on this symbol+side is active in the last 30 min
      if (await symbolDedupHit(setup.symbol, side)) continue

      // Compute SL & TP relative to limit price
      const opp = nearestOpposite(side, lvl.price, allPrices)
      const slBuf = atr * cfg.slBufferAtr
      const sl = opp !== null
        ? (side === 'BUY' ? opp - slBuf : opp + slBuf)
        : (side === 'BUY' ? lvl.price - atr * cfg.fallbackSlAtr : lvl.price + atr * cfg.fallbackSlAtr)
      const tpLadder = buildLadder(side, lvl.price, lvl.price, allPrices, atr * cfg.tpMinAtr)
      if (tpLadder.length === 0) continue
      // Sanity: SL on correct side
      if ((side === 'BUY' && sl >= lvl.price) || (side === 'SELL' && sl <= lvl.price)) continue
      // R:R filter — reject bad geometry (TP1 too close vs SL, or SL too tight vs TP1)
      if (!passesRRFilter(side, lvl.price, sl, tpLadder, cfg.minRR, cfg.maxRR)) continue

      const now = Date.now()
      const pendingExpiresAt = new Date(now + PENDING_VALID_HOURS * 60 * 60_000)
      const expiresAt = new Date(now + expiryHours * 60 * 60_000)

      const reason = `LIMIT_PENDING ${side} @ ${lvl.source} ${lvl.price.toFixed(4)} (fibo ${impulse.direction}, awaiting fill within ${PENDING_VALID_HOURS}h)`

      const dbCreated = await prisma.levelsSignal.create({
        data: {
          symbol: setup.symbol,
          market: setup.market,
          side,
          event: 'REACTION', // semantically a reaction-style entry
          source: lvl.source,
          level: lvl.price,
          entryPrice: lvl.price,
          stopLoss: sl,
          initialStop: sl,
          currentStop: sl,
          tpLadder,
          isFiboConfluence: true,
          fiboImpulse: impulse as any,
          reason,
          status: 'PENDING',
          entryMode: 'LIMIT',
          pendingExpiresAt,
          expiresAt,
        },
      })

      // Telegram notify (best-effort)
      let depositUsd: number | undefined, riskPctPerTrade: number | undefined
      try {
        const paperCfg = await prisma.levelsPaperConfig.findUnique({ where: { id: 1 } })
        if (paperCfg) { depositUsd = paperCfg.currentDepositUsd; riskPctPerTrade = paperCfg.riskPctPerTrade }
      } catch {}
      try {
        await sendNotification('LEVELS_PENDING' as any, {
          id: dbCreated.id,
          symbol: setup.symbol,
          market: setup.market,
          side,
          source: lvl.source,
          level: lvl.price,
          entryPrice: lvl.price,
          stopLoss: sl,
          tpLadder,
          isFibo: true,
          reason,
          depositUsd,
          riskPctPerTrade,
          pendingExpiresAt,
        })
        await prisma.levelsSignal.update({ where: { id: dbCreated.id }, data: { notifiedTelegram: true } })
      } catch (e: any) {
        console.error('[LevelsScanner] LIMIT pending notify failed:', e.message)
      }

      console.log(`[LevelsScanner] PENDING ${setup.symbol} ${side} @ ${lvl.source} ${lvl.price.toFixed(4)} (id=${dbCreated.id})`)
      created++
    }
  }
  return created
}

async function scanSymbol(setup: SymbolSetup, expiryHours: number): Promise<number> {
  let signalsFired = 0
  try {
    const { m5, m15, h1, d1 } = await loadCandles(setup)
    if (m5.length < 50) {
      console.warn(`[LevelsScanner] ${setup.symbol}: not enough 5m candles (${m5.length})`)
      return 0
    }
    const cfg = buildCfg(setup.fractalLR, setup.tpMinAtr ?? 0)

    // === LIMIT mode: scan active levels in fibo zone, create PENDING signals ===
    if (setup.entryMode === 'LIMIT') {
      signalsFired = await scanLimitPending(setup, m5, m15, h1, d1, cfg, expiryHours)
      return signalsFired
    }

    // === MARKET mode (default): wait for confirmed reaction signal on the last bar ===
    const w1 = aggregateDailyToWeekly(d1)
    const pre = precomputeLevelsV2(m5, d1, w1, cfg, m15, h1)

    // Replay last few bars to populate signal state (pending pierces)
    const state = newSignalState()
    const lastN = Math.min(m5.length, 50) // 50 bars ≈ 4h on 5m — sufficient for retest window
    const replayStart = m5.length - lastN
    for (let i = replayStart; i < m5.length - 1; i++) {
      generateSignalV2(m5, i, cfg, pre, state)
    }

    // Now the actual check: did the LAST CLOSED bar fire a signal?
    const lastIdx = m5.length - 1
    const sig = generateSignalV2(m5, lastIdx, cfg, pre, state)
    if (!sig) return 0

    // Side filter (per-setup direction restriction)
    if (setup.side !== 'BOTH' && sig.side !== setup.side) return 0

    // Dedup (same level, 1h window)
    if (await dedupHit(setup.symbol, sig.side, sig.level)) {
      console.log(`[LevelsScanner] ${setup.symbol} dedup hit on ${sig.side} ${sig.level.toFixed(2)}`)
      return 0
    }
    // Symbol dedup (any level, 30min window) — prevents stacking 3+ entries on same coin
    if (await symbolDedupHit(setup.symbol, sig.side)) {
      console.log(`[LevelsScanner] ${setup.symbol} symbol dedup: ${sig.side} signal already active in last 30 min`)
      return 0
    }

    await saveAndNotify(setup, sig, expiryHours)
    signalsFired++
  } catch (e: any) {
    console.error(`[LevelsScanner] ${setup.symbol} scan failed:`, e.message)
  }
  return signalsFired
}

/** Run one scan cycle across all enabled setups. Returns total signals fired. */
export async function runLevelsScanCycle(): Promise<{ totalFired: number; perSymbol: Record<string, number> }> {
  const cfg = await prisma.levelsConfig.findUnique({ where: { id: 1 } })
  if (!cfg || !cfg.enabled) {
    return { totalFired: 0, perSymbol: {} }
  }

  // Parse enabled list: each entry is "SYMBOL:SIDE" or "SYMBOL" (BOTH)
  const enabledList = (cfg.symbolsEnabled as any[]) || []
  const enabledMap = new Map<string, AllowedSide>()
  for (const entry of enabledList) {
    if (typeof entry !== 'string') continue
    const [sym, sideRaw] = entry.split(':')
    const side: AllowedSide = sideRaw === 'BUY' ? 'BUY' : sideRaw === 'SELL' ? 'SELL' : 'BOTH'
    enabledMap.set(sym, side)
  }
  // If config is empty → use all DEFAULT_SETUPS
  const useAll = enabledMap.size === 0

  const perSymbol: Record<string, number> = {}
  let totalFired = 0
  for (const setup of DEFAULT_SETUPS) {
    if (!useAll && !enabledMap.has(setup.symbol)) continue
    const sideOverride = enabledMap.get(setup.symbol)
    const effectiveSetup = sideOverride ? { ...setup, side: sideOverride } : setup
    const fired = await scanSymbol(effectiveSetup, cfg.expiryHours)
    perSymbol[setup.symbol] = fired
    totalFired += fired
  }

  await prisma.levelsConfig.update({
    where: { id: 1 },
    data: { lastScanAt: new Date(), lastScanResult: perSymbol },
  })

  console.log(`[LevelsScanner] cycle done: ${totalFired} new signal(s)`, perSymbol)
  return { totalFired, perSymbol }
}

let levelsScanInterval: NodeJS.Timeout | null = null

export function startLevelsScanner(): void {
  if (levelsScanInterval) return
  // First run immediately, then every 5 min by default (read from config)
  const tick = async () => {
    try {
      await runLevelsScanCycle()
    } catch (e: any) {
      console.error('[LevelsScanner] tick error:', e.message)
    }
  }
  // Initial delay of 30s to let server boot
  setTimeout(tick, 30_000)
  levelsScanInterval = setInterval(tick, 5 * 60_000)
  console.log('[LevelsScanner] started (5 min interval)')
}

export function stopLevelsScanner(): void {
  if (levelsScanInterval) {
    clearInterval(levelsScanInterval)
    levelsScanInterval = null
  }
}
