/**
 * Daily Breakout Live Scanner — production cron runner.
 *
 * Каждый tick (default 5 min):
 *   1) Для каждого enabled symbol:
 *      - Грузим recent 5m candles (~ last 24h)
 *      - Определяем UTC date текущей закрытой свечи
 *      - Detect range за этот день (если range bars готовы)
 *      - Проверяем последнюю закрытую свечу на breakout
 *      - Если есть signal И за этот день ещё нет signal на этом symbol → save + notify + paper trade
 *
 * Dedupe: один signal per UTC date per symbol (через DB lookup на rangeDate).
 *
 * Backtest 365d (runBacktest_dailybreak_detailed.ts) — optimal config:
 *   3h range, vol×2.0, 11 monetах: TRAIN +0.16 R/tr, TEST +0.34 R/tr
 */

import { prisma } from '../db/prisma'
import { OHLCV } from './market'
import { loadHistorical } from '../scalper/historicalLoader'
import {
  detectRange, generateBreakoutSignal, utcDateOf, endOfDayUTC,
  DEFAULT_BREAKOUT_CFG, BreakoutEngineConfig, BreakoutSignal,
} from '../scalper/dailyBreakoutEngine'
import { sendNotification, VariantOpenInfo } from './notifier'
import { runBreakoutPaperCycle, OpenedTradeInfo } from './dailyBreakoutPaperTrader'
import { getBtcAdx1h, BTC_ADX_THRESHOLD } from './btcRegime'

// Default setups (23 monetах) — refreshed 2026-05-09 after re-running universe backtest
// across 158 cached symbols. ACCEPT criteria: TEST R/tr >= +0.20, TRAIN R/tr > 0,
// FULL N >= 30, TEST N >= 10.
//
// Removed from prev 32 (failed TEST on fresh data):
//   HYPE, XRP, SOL, ARB, AVAX, 1000PEPE, BLUR, SAND, ETC, IO, TSTBSC, STRK
// Added (new ACCEPT):
//   USELESSUSDT (TEST +0.23), SIRENUSDT (+0.23), 1000BONKUSDT (+0.21)
//
// Already-open trades on removed symbols continue to be tracked by the paper
// trader until their TP/SL/expiry — this list only governs which symbols the
// scanner generates NEW signals for.
export const DEFAULT_BREAKOUT_SETUPS: string[] = [
  // Survivors from previous prod set (passed TEST R/tr >= +0.20 on fresh data)
  'ETHUSDT',         // TEST +0.48 N=26
  'AAVEUSDT',        // TEST +0.55 N=24
  'ENAUSDT',         // TEST +1.02 N=10
  'SEIUSDT',         // TEST +0.44 N=25
  'MUSDT',           // TEST +1.78 N=36
  'LDOUSDT',         // TEST +1.24 N=15
  'DYDXUSDT',        // TEST +0.73 N=71
  'ZECUSDT',         // TEST +0.49 N=50
  'STXUSDT',         // TEST +0.39 N=24
  'IPUSDT',          // TEST +0.36 N=15
  'ORDIUSDT',        // TEST +0.57 N=24
  'ARUSDT',          // TEST +0.24 N=12
  'DOGEUSDT',        // TEST +0.26 N=17
  'TRUMPUSDT',       // TEST +0.29 N=39
  'KASUSDT',         // TEST +0.38 N=39
  'SHIB1000USDT',    // TEST +0.29 N=37
  'FARTCOINUSDT',    // TEST +0.25 N=31
  'AEROUSDT',        // TEST +0.33 N=48
  'POLUSDT',         // TEST +0.21 N=85
  'VVVUSDT',         // TEST +0.23 N=71
  // New ACCEPT 2026-05-09
  'USELESSUSDT',     // TEST +0.23 N=19
  'SIRENUSDT',       // TEST +0.23 N=45
  '1000BONKUSDT',    // TEST +0.21 N=25
]

/** Загружает последние 36+24+1 = ~60 5m свечей чтобы хватило range + volume window + last bar */
async function loadRecentCandles(symbol: string): Promise<OHLCV[]> {
  // 1 day = 288 5m candles. Load 2 days to be safe (covers range + volume avg + intraday).
  const candles = await loadHistorical(symbol, '5m', 1, 'bybit', 'linear')
  // Keep last ~600 candles (~50h) — enough for range + volume + late breakouts
  return candles.slice(-600)
}

async function alreadySignaledToday(symbol: string, utcDate: string): Promise<boolean> {
  const existing = await prisma.breakoutSignal.findFirst({
    where: { symbol, rangeDate: utcDate },
  })
  return !!existing
}

async function saveSignal(
  symbol: string,
  sig: BreakoutSignal,
): Promise<void> {
  const expiresAt = new Date(endOfDayUTC(sig.rangeDate))

  const created = await prisma.breakoutSignal.create({
    data: {
      symbol,
      side: sig.side,
      rangeHigh: sig.rangeHigh,
      rangeLow: sig.rangeLow,
      rangeSize: sig.rangeSize,
      rangeDate: sig.rangeDate,
      entryPrice: sig.entryPrice,
      stopLoss: sig.stopLoss,
      initialStop: sig.stopLoss,
      currentStop: sig.stopLoss,
      tpLadder: sig.tpLadder,
      volumeAtBreakout: sig.volumeAtBreakout,
      avgVolume: sig.avgVolume,
      reason: sig.reason,
      status: 'NEW',
      expiresAt,
    },
  })

  console.log(`[BreakoutScanner] NEW ${symbol} ${sig.side} @ ${sig.entryPrice.toFixed(4)} (range ${sig.rangeLow.toFixed(4)}-${sig.rangeHigh.toFixed(4)}, id=${created.id})`)
}

async function scanSymbol(symbol: string, cfg: BreakoutEngineConfig): Promise<number> {
  try {
    const candles = await loadRecentCandles(symbol)
    if (candles.length < cfg.rangeBars + 25) {
      console.warn(`[BreakoutScanner] ${symbol}: not enough candles (${candles.length})`)
      return 0
    }

    // Last CLOSED candle — last index
    const lastIdx = candles.length - 1
    const lastCandle = candles[lastIdx]
    const utcDate = utcDateOf(lastCandle.time)

    // Skip if already signaled today
    if (await alreadySignaledToday(symbol, utcDate)) return 0

    // Detect range for this UTC date
    const range = detectRange(candles, utcDate, cfg)
    if (!range) return 0

    // Range must be COMPLETE (last candle past rangeEndTime)
    if (lastCandle.time < range.rangeEndTime) return 0

    // Check the LAST closed candle for breakout
    const sig = generateBreakoutSignal(candles, range, lastIdx, cfg)
    if (!sig) return 0

    await saveSignal(symbol, sig)
    return 1
  } catch (e: any) {
    console.error(`[BreakoutScanner] ${symbol} scan failed:`, e.message)
    return 0
  }
}

async function getOrCreateConfig() {
  let cfg = await prisma.breakoutConfig.findUnique({ where: { id: 1 } })
  if (!cfg) {
    cfg = await prisma.breakoutConfig.create({ data: { id: 1 } })
  }
  return cfg
}

async function runOnce(): Promise<void> {
  let dbCfg
  try {
    dbCfg = await getOrCreateConfig()
  } catch (e: any) {
    console.warn('[BreakoutScanner] config table missing — migration not yet applied:', e.message)
    return
  }
  if (!dbCfg.enabled) return

  const enabledSymbols = (dbCfg.symbolsEnabled as string[]).length > 0
    ? dbCfg.symbolsEnabled as string[]
    : DEFAULT_BREAKOUT_SETUPS

  const engineCfg: BreakoutEngineConfig = {
    rangeBars: dbCfg.rangeBars,
    volumeMultiplier: dbCfg.volumeMultiplier,
    tp1Mult: 1.0, tp2Mult: 2.0, tp3Mult: 3.0,
  }

  // BTC regime filter: skip the entire tick when BTC is in sideways regime
  // (ADX(14) on 1h ≤ threshold). Altcoin breakouts in pure BTC range have
  // systematically worse R/tr in 365d backtest. If ADX fetch fails, we
  // proceed without the filter (fail-open) — better to miss a guard than
  // miss all signals.
  const btcAdx = await getBtcAdx1h()
  if (btcAdx != null && btcAdx <= BTC_ADX_THRESHOLD) {
    console.log(`[BreakoutScanner] tick skipped — BTC ADX ${btcAdx.toFixed(1)} ≤ ${BTC_ADX_THRESHOLD} (sideways regime)`)
    await prisma.breakoutConfig.update({
      where: { id: 1 },
      data: { lastScanAt: new Date(), lastScanResult: { _btcAdx: Math.round(btcAdx * 10) / 10, _skipped: 1 } as any },
    })
    return
  }

  const result: Record<string, number> = {}
  let total = 0
  for (const symbol of enabledSymbols) {
    const n = await scanSymbol(symbol, engineCfg)
    result[symbol] = n
    total += n
  }

  await prisma.breakoutConfig.update({
    where: { id: 1 },
    data: { lastScanAt: new Date(), lastScanResult: result },
  })
  if (total > 0) {
    console.log(`[BreakoutScanner] tick fired ${total} signals across ${enabledSymbols.length} symbols`)
    // Trigger paper cycle immediately for both variants so the trade opens on the same
    // breakout candle. We collect what each variant actually opened, then emit ONE
    // consolidated Telegram message per signal listing whichever variants took it
    // (А, Б, or both). Skipped/blocked signals get no notification — Telegram only
    // mirrors actually-opened trades.
    let openedA: OpenedTradeInfo[] = []
    let openedB: OpenedTradeInfo[] = []
    try {
      const r = await runBreakoutPaperCycle('A')
      openedA = r.openedTrades
      if (r.opened > 0) {
        console.log(`[BreakoutScanner] inline paper-A open: opened=${r.opened} delta=${r.depositDelta.toFixed(2)} depo=$${r.deposit.toFixed(2)}`)
      }
    } catch (e: any) {
      console.warn('[BreakoutScanner] inline paper-A cycle failed:', e?.message ?? e)
    }
    try {
      const r = await runBreakoutPaperCycle('B')
      openedB = r.openedTrades
      if (r.opened > 0) {
        console.log(`[BreakoutScanner] inline paper-B open: opened=${r.opened} delta=${r.depositDelta.toFixed(2)} depo=$${r.deposit.toFixed(2)}`)
      }
    } catch (e: any) {
      console.warn('[BreakoutScanner] inline paper-B cycle failed:', e?.message ?? e)
    }

    await notifyOpenedTrades(openedA, openedB)
  }
}

function toVariantInfo(t: OpenedTradeInfo, variant: 'A' | 'B'): VariantOpenInfo {
  return {
    variant,
    depositUsd: t.depositUsd,
    riskPctPerTrade: t.riskPctPerTrade,
    riskUsd: t.riskUsd,
    positionSizeUsd: t.positionSizeUsd,
    positionUnits: t.positionUnits,
    marginUsd: t.marginUsd,
    leverage: t.leverage,
    cappedByMaxLeverage: t.cappedByMaxLeverage,
    targetMarginPct: t.targetMarginPct,
  }
}

async function notifyOpenedTrades(openedA: OpenedTradeInfo[], openedB: OpenedTradeInfo[]): Promise<void> {
  // Group both variants' opens by signalId — one signal can be picked up by A,
  // B, or both. Variant order in the message follows entry order: A first, then B.
  const bySig = new Map<number, { a?: OpenedTradeInfo; b?: OpenedTradeInfo }>()
  for (const t of openedA) bySig.set(t.signalId, { ...(bySig.get(t.signalId) ?? {}), a: t })
  for (const t of openedB) bySig.set(t.signalId, { ...(bySig.get(t.signalId) ?? {}), b: t })

  for (const [signalId, pair] of bySig) {
    const ref = pair.a ?? pair.b
    if (!ref) continue
    const variants: VariantOpenInfo[] = []
    if (pair.a) variants.push(toVariantInfo(pair.a, 'A'))
    if (pair.b) variants.push(toVariantInfo(pair.b, 'B'))

    try {
      await sendNotification('BREAKOUT_OPENED', {
        symbol: ref.symbol,
        side: ref.side,
        reason: ref.reason,
        variants,
      })
      // Mark notify only on signals A actually saw — variant B never mutates
      // the shared signal row (legacy contract).
      if (pair.a) {
        try {
          await prisma.breakoutSignal.update({
            where: { id: signalId },
            data: { notifiedTelegram: true },
          })
        } catch { /* signal could have been deleted concurrently — ignore */ }
      }
    } catch (e: any) {
      console.error(`[BreakoutScanner] OPENED notify failed for sig ${signalId}: ${e.message}`)
    }
  }
}

export { runOnce as runBreakoutScanCycleNow }

let scannerInterval: NodeJS.Timeout | null = null
export function startBreakoutLiveScanner(): void {
  if (scannerInterval) return
  console.log('[BreakoutScanner] starting (5min cron)')
  // Run once on boot, then every 5 min
  runOnce().catch(e => console.error('[BreakoutScanner] initial run failed:', e.message))
  scannerInterval = setInterval(() => {
    runOnce().catch(e => console.error('[BreakoutScanner] tick failed:', e.message))
  }, 5 * 60_000)
}

export function stopBreakoutLiveScanner(): void {
  if (scannerInterval) { clearInterval(scannerInterval); scannerInterval = null }
}
