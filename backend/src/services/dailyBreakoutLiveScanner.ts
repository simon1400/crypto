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
import { sendNotification } from './notifier'
import { runBreakoutPaperCycle } from './dailyBreakoutPaperTrader'

// Default setups (32 monetах) — current 11 prod + 21 new ACCEPT кандидатов из universe backtest 2026-05-07.
// ACCEPT criteria: TEST R/tr >= +0.20, TRAIN R/tr > 0, FULL N >= 30, TEST N >= 10.
// Hypothetical portfolio: TEST R/tr +0.39 (vs current +0.34) on 1132 trades.
export const DEFAULT_BREAKOUT_SETUPS: string[] = [
  // Current production (11) — kept even if some don't pass new strict criteria
  'ETHUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'AVAXUSDT',
  'ARBUSDT',
  'AAVEUSDT',
  'ENAUSDT',
  'HYPEUSDT',
  '1000PEPEUSDT',
  'SEIUSDT',
  'BLURUSDT',
  // New ACCEPT (21) — sorted by TEST R/tr desc
  'MUSDT',           // TEST +2.70 N=31
  'LDOUSDT',         // TEST +1.41 N=16
  'DYDXUSDT',        // TEST +0.76 N=65
  'ZECUSDT',         // TEST +0.51 N=51
  'STXUSDT',         // TEST +0.51 N=11
  'IPUSDT',          // TEST +0.50 N=16
  'SANDUSDT',        // TEST +0.47 N=13
  'ORDIUSDT',        // TEST +0.42 N=27
  'ARUSDT',          // TEST +0.41 N=12
  'DOGEUSDT',        // TEST +0.40 N=19
  'TRUMPUSDT',       // TEST +0.36 N=40
  'STRKUSDT',        // TEST +0.35 N=26
  'KASUSDT',         // TEST +0.33 N=39
  'SHIB1000USDT',    // TEST +0.32 N=39
  'FARTCOINUSDT',    // TEST +0.28 N=29
  'AEROUSDT',        // TEST +0.27 N=49
  'ETCUSDT',         // TEST +0.24 N=25
  'IOUSDT',          // TEST +0.24 N=45
  'POLUSDT',         // TEST +0.23 N=80
  'TSTBSCUSDT',      // TEST +0.23 N=30
  'VVVUSDT',         // TEST +0.21 N=70
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

async function saveAndNotify(
  symbol: string,
  sig: BreakoutSignal,
  triggerTime: number,
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

  // Telegram notification — include position sizing if paper trading is configured
  let depositUsd: number | undefined
  let riskPctPerTrade: number | undefined
  try {
    const paperCfg = await prisma.breakoutPaperConfig.findUnique({ where: { id: 1 } })
    if (paperCfg) {
      depositUsd = paperCfg.currentDepositUsd
      riskPctPerTrade = paperCfg.riskPctPerTrade
    }
  } catch {}

  try {
    await sendNotification('BREAKOUT_NEW' as any, {
      id: created.id,
      symbol,
      side: sig.side,
      entryPrice: sig.entryPrice,
      stopLoss: sig.stopLoss,
      tpLadder: sig.tpLadder,
      rangeHigh: sig.rangeHigh,
      rangeLow: sig.rangeLow,
      rangeSize: sig.rangeSize,
      reason: sig.reason,
      depositUsd,
      riskPctPerTrade,
    })
    await prisma.breakoutSignal.update({
      where: { id: created.id },
      data: { notifiedTelegram: true },
    })
  } catch (e: any) {
    console.error('[BreakoutScanner] notify failed:', e.message)
  }

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

    await saveAndNotify(symbol, sig, lastCandle.time)
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
    // Trigger paper cycle immediately so the trade opens on the same breakout candle
    // (and the user sees it in the UI right after the Telegram alert).
    try {
      const r = await runBreakoutPaperCycle()
      if (r.opened > 0) {
        console.log(`[BreakoutScanner] inline paper open: opened=${r.opened} delta=${r.depositDelta.toFixed(2)} depo=$${r.deposit.toFixed(2)}`)
      }
    } catch (e: any) {
      console.warn('[BreakoutScanner] inline paper cycle failed:', e?.message ?? e)
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
