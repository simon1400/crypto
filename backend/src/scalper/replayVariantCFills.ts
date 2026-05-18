/**
 * One-off recovery script: replay BreakoutPaperTradeC trades that were filled
 * by the broken "realistic fill model" (commit d120c60 from 2026-05-17).
 *
 * The bug: realistic fill checked `candle.low <= limit` for BUY (reversal-style
 * buy-the-dip), but variant C places BUY at rangeHigh — that's a BREAKOUT entry
 * which must fire when `candle.high >= limit`. Result: BUY limits filled
 * immediately on the first dip after placement (entry price = rangeHigh, but
 * market was already trading much lower — guaranteed SL).
 *
 * What this script does for each trade closed by the broken fill (id 293..):
 *   1. Find the FIRST 5m candle after limitPlacedAt where the correct breakout
 *      condition fired (BUY: high >= limit; SELL: low <= limit).
 *   2. If no such candle exists, the trade should never have filled — mark it
 *      CANCELLED_EOD (limit expired) and zero out P&L.
 *   3. If it exists, replay the trade's life from that candle forward using
 *      the same TP/SL/trailing logic as trackOnePaper. Walk 5m candles to
 *      determine real terminal status: OPEN / TP1_HIT / TP2_HIT / TP3_HIT /
 *      SL_HIT / CLOSED / EXPIRED, plus closes[] and netPnlUsd.
 *   4. Recompute config currentDeposit as starting + sum(netPnl).
 *
 * Dry-run by default. Pass `--apply` to write back to DB.
 *
 * Usage:
 *   npx tsx src/scalper/replayVariantCFills.ts
 *   npx tsx src/scalper/replayVariantCFills.ts --apply
 */

import { prisma } from '../db/prisma'
import { loadHistorical } from './historicalLoader'
import { OHLCV } from '../services/market'
import { takerFillPrice, isMakerFill } from '../services/dailyBreakoutPaperTrader'

const SPLITS = [0.5, 0.3, 0.2]
// 17.05 03:00 UTC — placements первого дня после деплоя broken realistic fill (d120c60).
// До этой даты fill mechanic был старый правильный, и replay даёт ложные отличия
// из-за MANUAL closes пользователем + меняющейся EOD-FLAT policy (была включена/
// выключена несколько раз 10-15.05). Замысел расширить до 10.05 был ошибочный —
// pre-bug сделки не нуждаются в пересчёте.
const SINCE_ISO = '2026-05-17T03:00:00Z'

interface CloseRecord {
  price: number
  percent: number
  pnlR: number
  pnlUsd: number
  closedAt: string
  reason: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'EXPIRED'
}

interface ReplayResult {
  filled: boolean
  realFillAt: Date | null
  // After replay:
  status: 'OPEN' | 'TP1_HIT' | 'TP2_HIT' | 'TP3_HIT' | 'CLOSED' | 'SL_HIT' | 'EXPIRED' | 'CANCELLED_EOD'
  currentStop: number
  closes: CloseRecord[]
  realizedR: number
  realizedPnlUsd: number
  feesPaidUsd: number
  slipPaidUsd: number
  netPnlUsd: number
  lastPriceCheckAt: Date | null
  closedAt: Date | null
}

async function replayTrade(trade: any, cfg: any): Promise<ReplayResult> {
  const side = trade.side as 'BUY' | 'SELL'
  const isLong = side === 'BUY'
  const limit = trade.limitOrderPrice as number
  const placedMs = new Date(trade.limitPlacedAt).getTime()

  const symbol = trade.symbol
  // Load enough history to cover from placement to now.
  const candles = await loadHistorical(symbol, '5m', 1, 'bybit', 'linear')
  // candles are ascending by time.
  const afterPlacement = candles.filter(c => c.time > placedMs)

  // Step 1: find first true breakout candle.
  let realFillIdx = -1
  for (let i = 0; i < afterPlacement.length; i++) {
    const c = afterPlacement[i]
    const breakout = isLong ? c.high >= limit : c.low <= limit
    if (breakout) { realFillIdx = i; break }
  }

  if (realFillIdx === -1) {
    return {
      filled: false,
      realFillAt: null,
      status: 'CANCELLED_EOD',
      currentStop: trade.initialStop,
      closes: [],
      realizedR: 0,
      realizedPnlUsd: 0,
      feesPaidUsd: 0,
      slipPaidUsd: 0,
      netPnlUsd: 0,
      lastPriceCheckAt: null,
      closedAt: new Date(),
    }
  }

  const fillCandle = afterPlacement[realFillIdx]
  const entry = limit  // breakout limits fill exactly at the limit price (maker)
  const initialStop = trade.initialStop as number
  const initialRisk = Math.abs(entry - initialStop)
  const tpLadder = (trade.tpLadder as any[]) as number[]
  const positionUnits = trade.positionUnits as number

  const takerPct = (trade.feeTakerPct ?? cfg.feeTakerPct) as number
  const makerPct = (trade.feeMakerPct ?? cfg.feeMakerPct) as number
  const slipPct = (trade.slipTakerPct ?? cfg.slipTakerPct) as number
  const slipFracExit = slipPct / 100

  // Entry fee for variant C: maker (the limit sits in book before breakout).
  // notional = positionUnits * entry  ; fee = notional * makerPct/100
  const entryNotional = positionUnits * entry
  const entryFeeUsd = entryNotional * (makerPct / 100)

  let currentStop = initialStop
  let nextTpIdx = 0
  let remainingFrac = 1
  let realizedR = 0
  let realizedPnlUsd = 0
  let slipPaidUsd = 0
  const closes: CloseRecord[] = []
  let status: ReplayResult['status'] = 'OPEN'
  let lastCandleTime = fillCandle.time
  let closedAt: Date | null = null

  // expiresAt = endOfDay UTC of fillCandle day at 23:55:00.000
  const fillDate = new Date(fillCandle.time)
  const expiresAtMs = Date.UTC(fillDate.getUTCFullYear(), fillDate.getUTCMonth(), fillDate.getUTCDate(), 23, 55, 0, 0)

  // Replay starts on the candle AFTER fill (the fill candle itself produced the entry).
  for (let i = realFillIdx + 1; i < afterPlacement.length; i++) {
    const c = afterPlacement[i]
    lastCandleTime = c.time

    // SL check first (worst case if both touch same candle)
    const slHit = isLong ? c.low <= currentStop : c.high >= currentStop
    if (slHit) {
      const slipFillPrice = takerFillPrice(currentStop, side, 'exit', slipFracExit)
      const pnlR = ((isLong ? slipFillPrice - entry : entry - slipFillPrice) / initialRisk) * remainingFrac
      const fillUnits = positionUnits * remainingFrac
      const pnlUsd = (isLong ? slipFillPrice - entry : entry - slipFillPrice) * fillUnits
      realizedR += pnlR
      realizedPnlUsd += pnlUsd
      slipPaidUsd += fillUnits * Math.abs(slipFillPrice - currentStop)
      closes.push({
        price: slipFillPrice, percent: remainingFrac * 100, pnlR, pnlUsd,
        closedAt: new Date(c.time).toISOString(), reason: 'SL',
      })
      remainingFrac = 0
      status = nextTpIdx === 0 ? 'SL_HIT' : 'CLOSED'
      closedAt = new Date(c.time)
      break
    }

    // TP cascade
    while (nextTpIdx < tpLadder.length && remainingFrac > 1e-6) {
      const tp = tpLadder[nextTpIdx]
      const tpHit = isLong ? c.high >= tp : c.low <= tp
      if (!tpHit) break

      const splitFrac = SPLITS[nextTpIdx] ?? remainingFrac
      const fillFrac = Math.min(splitFrac, remainingFrac)
      const pnlR = ((isLong ? tp - entry : entry - tp) / initialRisk) * fillFrac
      const fillUnits = positionUnits * fillFrac
      const pnlUsd = (isLong ? tp - entry : entry - tp) * fillUnits
      realizedR += pnlR
      realizedPnlUsd += pnlUsd
      const tpName = (`TP${nextTpIdx + 1}`) as 'TP1' | 'TP2' | 'TP3'
      closes.push({
        price: tp, percent: fillFrac * 100, pnlR, pnlUsd,
        closedAt: new Date(c.time).toISOString(), reason: tpName,
      })
      remainingFrac -= fillFrac

      // Variant C: autoTrailingSL is true by default — move stop after each TP.
      const trailEnabled = trade.autoTrailingSL ?? cfg.autoTrailingSL
      if (trailEnabled) {
        if (nextTpIdx === 0) currentStop = entry
        else currentStop = tpLadder[nextTpIdx - 1]
      }

      status = nextTpIdx === 0 ? 'TP1_HIT' : nextTpIdx === 1 ? 'TP2_HIT' : 'TP3_HIT'
      nextTpIdx++
      if (remainingFrac <= 1e-6) { status = 'CLOSED'; closedAt = new Date(c.time); break }
    }
    if ((status as string) === 'CLOSED' || (status as string) === 'SL_HIT') break

    // EOD-FLAT: close any open position at 23:55 UTC on fill day.
    if (c.time >= expiresAtMs && remainingFrac > 1e-6) {
      const lastPrice = c.close
      const slipFillPrice = takerFillPrice(lastPrice, side, 'exit', slipFracExit)
      const pnlR = ((isLong ? slipFillPrice - entry : entry - slipFillPrice) / initialRisk) * remainingFrac
      const fillUnits = positionUnits * remainingFrac
      const pnlUsd = (isLong ? slipFillPrice - entry : entry - slipFillPrice) * fillUnits
      realizedR += pnlR
      realizedPnlUsd += pnlUsd
      slipPaidUsd += fillUnits * Math.abs(slipFillPrice - lastPrice)
      closes.push({
        price: slipFillPrice, percent: remainingFrac * 100, pnlR, pnlUsd,
        closedAt: new Date(c.time).toISOString(), reason: 'EXPIRED',
      })
      remainingFrac = 0
      status = 'EXPIRED'
      closedAt = new Date(c.time)
      break
    }
  }

  // Per-event fees (taker on SL/EXPIRED, maker on TP) + entry maker fee.
  let exitFeesUsd = 0
  for (const f of closes) {
    const notional = positionUnits * f.price * (f.percent / 100)
    const rate = isMakerFill(f.reason) ? makerPct : takerPct
    exitFeesUsd += notional * (rate / 100)
  }
  const feesPaidUsd = entryFeeUsd + exitFeesUsd
  const netPnlUsd = realizedPnlUsd - feesPaidUsd

  return {
    filled: true,
    realFillAt: new Date(fillCandle.time),
    status,
    currentStop,
    closes,
    realizedR,
    realizedPnlUsd,
    feesPaidUsd,
    slipPaidUsd,
    netPnlUsd,
    lastPriceCheckAt: new Date(lastCandleTime),
    closedAt,
  }
}

async function main() {
  const apply = process.argv.includes('--apply')
  console.log(apply ? '=== APPLYING CHANGES ===' : '=== DRY RUN (use --apply to write) ===')
  console.log('')

  const cfg = await prisma.breakoutPaperConfigC.findUnique({ where: { id: 1 } })
  if (!cfg) throw new Error('BreakoutPaperConfigC not found')

  const trades = await prisma.breakoutPaperTradeC.findMany({
    where: {
      limitFilledAt: { gte: new Date(SINCE_ISO) },
      // Skip rows that were cancel-cascaded (the SELL side of a filled pair, etc.)
      limitOrderState: { in: ['FILLED'] },
    },
    orderBy: { limitFilledAt: 'asc' },
  })

  console.log(`Found ${trades.length} FILLED trades since ${SINCE_ISO}`)
  console.log('')

  const summary: any[] = []
  let totalNetPnlNew = 0
  let totalNetPnlOld = 0

  for (const t of trades) {
    const oldNetPnl = t.netPnlUsd
    totalNetPnlOld += oldNetPnl

    const r = await replayTrade(t, cfg)
    totalNetPnlNew += r.netPnlUsd

    const tStr = (d: Date | null) => d ? d.toISOString().slice(5, 16).replace('T', ' ') : '—'
    const oldStatus = t.status
    const diffStatus = oldStatus !== r.status ? `${oldStatus}→${r.status}` : r.status
    const diffPnl = (r.netPnlUsd - oldNetPnl)
    summary.push({
      id: t.id, symbol: t.symbol, side: t.side,
      limit: t.limitOrderPrice,
      oldFill: tStr(t.limitFilledAt),
      newFill: tStr(r.realFillAt),
      diffStatus,
      oldPnl: oldNetPnl.toFixed(2),
      newPnl: r.netPnlUsd.toFixed(2),
      diff: (diffPnl >= 0 ? '+' : '') + diffPnl.toFixed(2),
      replay: r,
    })

    // Print only diff rows by default (use --all to print everything).
    const printAll = process.argv.includes('--all')
    const isDiff = Math.abs(diffPnl) > 0.01 || oldStatus !== r.status
    if (printAll || isDiff) {
      console.log(
        `#${String(t.id).padEnd(4)} ${t.symbol.padEnd(13)} ${t.side.padEnd(4)} ` +
        `L=${String(t.limitOrderPrice).padEnd(10)} ` +
        `oldFill=${tStr(t.limitFilledAt).padEnd(11)} newFill=${tStr(r.realFillAt).padEnd(11)} ` +
        `${diffStatus.padEnd(20)} ` +
        `pnl ${oldNetPnl.toFixed(2).padStart(8)} → ${r.netPnlUsd.toFixed(2).padStart(8)} ` +
        `(${diffPnl >= 0 ? '+' : ''}${diffPnl.toFixed(2)})`,
      )
    }
  }

  console.log('')
  console.log(`SUM netPnl OLD: ${totalNetPnlOld.toFixed(2)}`)
  console.log(`SUM netPnl NEW: ${totalNetPnlNew.toFixed(2)}`)
  console.log(`DEPO DELTA:     ${(totalNetPnlNew - totalNetPnlOld >= 0 ? '+' : '') + (totalNetPnlNew - totalNetPnlOld).toFixed(2)}`)
  console.log('')
  console.log(`Current depo:   ${cfg.currentDepositUsd.toFixed(2)}`)
  const newDepo = cfg.currentDepositUsd + (totalNetPnlNew - totalNetPnlOld)
  console.log(`Would become:   ${newDepo.toFixed(2)}`)

  if (!apply) {
    console.log('')
    console.log('Dry-run only. Re-run with --apply to persist.')
    return
  }

  console.log('')
  console.log('=== APPLYING ===')

  for (const row of summary) {
    const r = row.replay as ReplayResult
    const data: any = {
      entryPrice: r.filled ? row.limit : 0,
      limitFilledAt: r.realFillAt,
      openedAt: r.realFillAt ?? new Date(),
      status: r.status === 'CANCELLED_EOD' ? 'CANCELLED' : r.status,
      limitOrderState: r.filled ? 'FILLED' : 'CANCELLED_EOD',
      currentStop: r.currentStop,
      closes: r.closes as any,
      realizedR: r.realizedR,
      realizedPnlUsd: r.realizedPnlUsd,
      feesPaidUsd: r.feesPaidUsd,
      slipPaidUsd: r.slipPaidUsd,
      netPnlUsd: r.netPnlUsd,
      lastPriceCheck: null,
      lastPriceCheckAt: r.lastPriceCheckAt,
      closedAt: r.closedAt,
    }
    await prisma.breakoutPaperTradeC.update({
      where: { id: row.id },
      data,
    })
  }

  // Recompute config aggregate stats from scratch over all C trades.
  const allTrades = await prisma.breakoutPaperTradeC.findMany({
    where: { status: { not: 'CANCELLED' } },
  })
  let totalPnl = 0
  let wins = 0
  let losses = 0
  let totalTrades = 0
  for (const t of allTrades) {
    if (['CLOSED', 'SL_HIT', 'EXPIRED', 'TP1_HIT', 'TP2_HIT', 'TP3_HIT'].includes(t.status)) {
      totalTrades++
      totalPnl += t.netPnlUsd
      if (t.netPnlUsd > 0) wins++
      else if (t.netPnlUsd < 0) losses++
    }
  }
  const newDepoFinal = cfg.startingDepositUsd + totalPnl
  await prisma.breakoutPaperConfigC.update({
    where: { id: 1 },
    data: {
      currentDepositUsd: newDepoFinal,
      totalPnLUsd: totalPnl,
      totalTrades,
      totalWins: wins,
      totalLosses: losses,
    },
  })

  console.log('')
  console.log(`Done. New depo: ${newDepoFinal.toFixed(2)} (totalPnl=${totalPnl.toFixed(2)} over ${totalTrades} trades, ${wins}W/${losses}L)`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1) })
