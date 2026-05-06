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
import { loadForexHistorical } from '../scalper/forexLoader'
import { loadPolygonHistorical } from '../scalper/polygonLoader'
import {
  precomputeLevelsV2, generateSignalV2, newSignalState, aggregateDailyToWeekly,
  DEFAULT_LEVELS_V2, LevelsV2Config, SignalV2,
} from '../scalper/levelsEngine2'
import { sendNotification } from './notifier'

// === Per-symbol production config (positive-EV combos from backtest) ===
// side: 'BUY' = LONG-only, 'SELL' = SHORT-only, 'BOTH' = trade both directions
type AllowedSide = 'BUY' | 'SELL' | 'BOTH'

interface SymbolSetup {
  symbol: string
  market: 'FOREX' | 'CRYPTO' | 'STOCK'
  side: AllowedSide
  fractalLR: 3 | 5
}

// Default setups — based on 365d backtest across 25+ symbols (2026-05-06).
// FOREX uses loosened Fibo gate (see buildCfg) — needed because 8×ATR impulses are rare on slow forex.
//
// 365d backtest results (V2 levels, ladder 50/30/20, fees crypto 0.08% / forex 0.04%):
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
  // Forex
  { symbol: 'XAUUSD',       market: 'FOREX',  side: 'BUY',  fractalLR: 3 }, // +1.19R/trade in 90d
  { symbol: 'EURUSD',       market: 'FOREX',  side: 'BUY',  fractalLR: 3 }, // neutral, low sample
  // Crypto majors
  { symbol: 'BTCUSDT',      market: 'CRYPTO', side: 'BOTH', fractalLR: 3 }, // +19.77R/trade in 90d (low n)
  // Crypto SHORTs (alt-bear regime 2025-2026)
  { symbol: 'XRPUSDT',      market: 'CRYPTO', side: 'SELL', fractalLR: 3 }, // +1.91 R/tr 365d ★
  { symbol: 'SEIUSDT',      market: 'CRYPTO', side: 'SELL', fractalLR: 3 }, // +0.85 R/tr 365d
  { symbol: 'WIFUSDT',      market: 'CRYPTO', side: 'SELL', fractalLR: 3 }, // +0.73 R/tr 365d
  { symbol: 'SOLUSDT',      market: 'CRYPTO', side: 'SELL', fractalLR: 3 }, // +0.69 R/tr 365d
  { symbol: 'ARBUSDT',      market: 'CRYPTO', side: 'SELL', fractalLR: 3 }, // +0.59 R/tr 365d
  { symbol: 'AVAXUSDT',     market: 'CRYPTO', side: 'SELL', fractalLR: 3 }, // +0.46 R/tr 365d
  { symbol: '1000PEPEUSDT', market: 'CRYPTO', side: 'SELL', fractalLR: 3 }, // +0.43 R/tr 365d
  { symbol: 'ETHUSDT',      market: 'CRYPTO', side: 'SELL', fractalLR: 3 }, // +0.30 R/tr 365d
  // Crypto LONG / BOTH outliers
  { symbol: 'HYPEUSDT',     market: 'CRYPTO', side: 'BUY',  fractalLR: 3 }, // +0.76 R/tr 365d
  { symbol: 'ENAUSDT',      market: 'CRYPTO', side: 'BOTH', fractalLR: 3 }, // +1.82 R/tr 365d
  // Stocks (Polygon free) — uncorrelated with crypto/forex, US trading hours only
  { symbol: 'USO',          market: 'STOCK',  side: 'BUY',  fractalLR: 3 }, // +0.59 R/tr 365d (WTI oil ETF proxy)
]

const DEDUP_WINDOW_MS = 60 * 60_000 // 1h: don't fire 2 signals on same level within 1h

function buildCfg(fractalLR: 3 | 5, market: 'FOREX' | 'CRYPTO' | 'STOCK' = 'CRYPTO'): LevelsV2Config {
  // Crypto = high volatility (BTC easily makes 8×ATR impulses).
  // Forex/Stocks = lower volatility — 8×ATR rarely happens during quiet sessions.
  // Loosen the fibo gate so we don't starve them of signals.
  const isLowVol = market === 'FOREX' || market === 'STOCK'
  return {
    ...DEFAULT_LEVELS_V2,
    fractalLeft: fractalLR, fractalRight: fractalLR,
    fractalLeftM15: 3, fractalRightM15: 3,
    fractalLeftH1: 3, fractalRightH1: 3,
    minSeparationAtr: 0.8, minTouchesBeforeSignal: 2,
    cooldownBars: 12,
    allowRangePlay: false,
    fiboMode: 'filter',
    fiboZoneFrom: isLowVol ? 0.382 : 0.5,
    fiboZoneTo:   isLowVol ? 0.786 : 0.618,
    fiboImpulseLookback: 100,
    fiboImpulseMinAtr: isLowVol ? 3.5 : 8,
  }
}

async function loadCandles(setup: SymbolSetup): Promise<{ m5: OHLCV[]; m15: OHLCV[]; h1: OHLCV[]; d1: OHLCV[] }> {
  if (setup.market === 'FOREX') {
    // Twelve Data — pull a small recent window (incremental cache will only fetch new candles)
    const m5  = await loadForexHistorical(setup.symbol, '5m', 1)   // ~30 days
    const m15 = await loadForexHistorical(setup.symbol, '15m', 1)
    const h1  = await loadForexHistorical(setup.symbol, '1h', 1)
    const d1  = await loadForexHistorical(setup.symbol, '1d', 3)   // 90 days for PDH/PDL/PWH/PWL
    return { m5, m15, h1, d1 }
  } else if (setup.market === 'STOCK') {
    // Polygon free — ETFs (US trading hours only)
    const m5  = await loadPolygonHistorical(setup.symbol, '5m', 1)
    const m15 = await loadPolygonHistorical(setup.symbol, '15m', 1)
    const h1  = await loadPolygonHistorical(setup.symbol, '1h', 1)
    const d1  = await loadPolygonHistorical(setup.symbol, '1d', 3)
    return { m5, m15, h1, d1 }
  } else {
    const m5  = await loadHistorical(setup.symbol, '5m',  1, 'bybit', 'linear')
    const m15 = await loadHistorical(setup.symbol, '15m', 1, 'bybit', 'linear')
    const h1  = await loadHistorical(setup.symbol, '1h',  1, 'bybit', 'linear')
    const d1  = await loadHistorical(setup.symbol, '1d',  3, 'bybit', 'linear')
    return { m5, m15, h1, d1 }
  }
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
      status: { in: ['NEW', 'ACTIVE', 'TP1_HIT', 'TP2_HIT'] },
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

async function scanSymbol(setup: SymbolSetup, expiryHours: number): Promise<number> {
  let signalsFired = 0
  try {
    const { m5, m15, h1, d1 } = await loadCandles(setup)
    if (m5.length < 50) {
      console.warn(`[LevelsScanner] ${setup.symbol}: not enough 5m candles (${m5.length})`)
      return 0
    }
    const w1 = aggregateDailyToWeekly(d1)
    const cfg = buildCfg(setup.fractalLR, setup.market)
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

    // Dedup
    if (await dedupHit(setup.symbol, sig.side, sig.level)) {
      console.log(`[LevelsScanner] ${setup.symbol} dedup hit on ${sig.side} ${sig.level.toFixed(2)}`)
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
