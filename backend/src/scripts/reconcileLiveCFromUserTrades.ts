/**
 * One-shot reconciliation for BreakoutLiveTradeC rows where closes[] entries
 * have pnlUsd=0 (bug pre-2026-05-20: flatten/manual close fired MARKET without
 * a tagged clientOrderId, so the WS refine never landed and the row got
 * frozen with a zero placeholder). Pulls /fapi/v1/userTrades from Binance for
 * each affected symbol/window, attributes fills to the matching trade row by
 * time + side + qty, and rewrites closes[].pnlUsd / .feePaidUsd / .price with
 * the authoritative numbers, then rebuilds row totals and config aggregates.
 *
 * Standalone — talks to Binance via raw HMAC so it can run on a VPS that's
 * still on the old code (doesn't depend on getUserTrades() being shipped).
 *
 * Run on VPS via: cd /opt/crypto/backend && npx tsx src/scripts/reconcileLiveCFromUserTrades.ts [--apply] [--id=N]
 *
 *   default      — dry-run, prints the per-row deltas it would apply
 *   --apply      — actually write the updates
 *   --id=N       — limit to a single trade id (good for spot-checking first)
 *
 * Idempotent: rows whose closes[] entries already carry non-zero pnlUsd are
 * skipped at the per-slice level. Safe to re-run.
 */

import * as crypto from 'crypto'
import { prisma } from '../db/prisma'

const APPLY = process.argv.includes('--apply')
const ID_ARG = process.argv.find((a) => a.startsWith('--id='))
const TARGET_ID = ID_ARG ? parseInt(ID_ARG.split('=')[1], 10) : null

// ============================================================================
// Binance keys + signed REST (inlined so the script runs on the old VPS code)
// ============================================================================

interface BinanceCreds { apiKey: string; apiSecret: string; net: 'testnet' | 'prod' }

const REST_BASE = {
  testnet: 'https://testnet.binancefuture.com',
  prod: 'https://fapi.binance.com',
}

async function decryptOrPlain(value: string | null | undefined): Promise<string | null> {
  if (!value) return null
  // The BotConfig encrypts keys with ENCRYPTION_KEY (Buffer => aes-256-gcm).
  // Mirror that here so we don't depend on the service module.
  const KEY = process.env.ENCRYPTION_KEY
  if (!KEY) {
    // Assume value is already plaintext.
    return value
  }
  try {
    const buf = Buffer.from(value, 'base64')
    if (buf.length < 12 + 16 + 1) return value  // not encrypted
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(12, 28)
    const enc = buf.subarray(28)
    const keyBuf = Buffer.from(KEY, 'hex')
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv)
    decipher.setAuthTag(tag)
    const dec = Buffer.concat([decipher.update(enc), decipher.final()])
    return dec.toString('utf8')
  } catch {
    return value
  }
}

async function getCreds(): Promise<BinanceCreds | null> {
  const bot = await prisma.botConfig.findUnique({ where: { id: 1 } })
  const cfg = await prisma.breakoutLiveConfigC.findUnique({ where: { id: 1 } })
  if (!bot || !cfg) return null
  const net: 'testnet' | 'prod' = cfg.useTestnet ? 'testnet' : 'prod'
  const rawKey = net === 'testnet' ? (bot as any).binanceTestnetApiKey : (bot as any).binanceProdApiKey
  const rawSec = net === 'testnet' ? (bot as any).binanceTestnetApiSecret : (bot as any).binanceProdApiSecret
  const apiKey = await decryptOrPlain(rawKey)
  const apiSecret = await decryptOrPlain(rawSec)
  if (!apiKey || !apiSecret) return null
  return { apiKey, apiSecret, net }
}

interface UserTrade {
  symbol: string; id: number; orderId: number; side: 'BUY' | 'SELL';
  price: string; qty: string; quoteQty: string;
  commission: string; commissionAsset: string;
  realizedPnl: string; time: number; buyer: boolean; maker: boolean;
}

async function syncServerTime(creds: BinanceCreds): Promise<number> {
  const r = await fetch(`${REST_BASE[creds.net]}/fapi/v1/time`)
  const d = await r.json() as { serverTime: number }
  return d.serverTime - Date.now()
}

async function getUserTrades(
  creds: BinanceCreds,
  symbol: string,
  startTime: number,
  endTime: number,
  serverOffset: number,
): Promise<UserTrade[]> {
  const params = new URLSearchParams()
  params.set('symbol', symbol)
  params.set('startTime', String(startTime))
  params.set('endTime', String(endTime))
  params.set('limit', '1000')
  params.set('recvWindow', '5000')
  params.set('timestamp', String(Date.now() + serverOffset))
  const sig = crypto.createHmac('sha256', creds.apiSecret).update(params.toString()).digest('hex')
  params.set('signature', sig)
  const r = await fetch(`${REST_BASE[creds.net]}/fapi/v1/userTrades?${params.toString()}`, {
    headers: { 'X-MBX-APIKEY': creds.apiKey },
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`userTrades ${symbol} ${r.status}: ${text.slice(0, 200)}`)
  return JSON.parse(text) as UserTrade[]
}

// ============================================================================
// Reconciliation core
// ============================================================================

interface CloseEntry {
  price: number
  percent: number
  pnlUsd: number
  pnlR?: number
  feePaidUsd?: number
  closedAt: string
  reason: string
  reasonNote?: string
  binanceOrderId?: string
}

async function recomputeRow(tradeId: number): Promise<void> {
  const t = await prisma.breakoutLiveTradeC.findUnique({ where: { id: tradeId } })
  if (!t) return
  const closes = (t.closes as any[]) ?? []
  const realizedPnl = closes.reduce((a, c) => a + (Number(c?.pnlUsd) || 0), 0)
  const closesFees = closes.reduce((a, c) => a + (Number(c?.feePaidUsd) || 0), 0)
  const fees = (t.entryFeeUsd ?? 0) + closesFees
  const netPnl = realizedPnl - fees - (t.fundingPaidUsd ?? 0)
  await prisma.breakoutLiveTradeC.update({
    where: { id: tradeId },
    data: { realizedPnlUsd: realizedPnl, feesPaidUsd: fees, netPnlUsd: netPnl },
  })
}

async function recomputeConfig(): Promise<void> {
  const cfg = await prisma.breakoutLiveConfigC.findUnique({ where: { id: 1 } })
  if (!cfg) return
  const trades = await prisma.breakoutLiveTradeC.findMany({
    where: {
      OR: [
        { status: { in: ['CLOSED', 'SL_HIT', 'EXPIRED', 'TP3_HIT'] } },
        { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] }, NOT: { closes: { equals: [] } } },
      ],
    },
    select: { status: true, netPnlUsd: true, realizedPnlUsd: true, feesPaidUsd: true, fundingPaidUsd: true },
  })
  const closedSet = new Set(['CLOSED', 'SL_HIT', 'EXPIRED', 'TP3_HIT'])
  const closedOnly = trades.filter((t) => closedSet.has(t.status))
  const totalTrades = closedOnly.length
  const totalWins = closedOnly.filter((t) => (t.netPnlUsd ?? 0) > 0).length
  const totalLosses = closedOnly.filter((t) => (t.netPnlUsd ?? 0) < 0).length
  const totalPnLUsd = trades.reduce((a, t) => {
    const realizedNet = closedSet.has(t.status)
      ? (t.netPnlUsd ?? 0)
      : ((t.realizedPnlUsd ?? 0) - (t.feesPaidUsd ?? 0) - (t.fundingPaidUsd ?? 0))
    return a + realizedNet
  }, 0)
  await prisma.breakoutLiveConfigC.update({
    where: { id: 1 },
    data: {
      totalTrades, totalWins, totalLosses, totalPnLUsd,
    },
  })
}

interface FixReport {
  tradeId: number
  symbol: string
  side: string
  status: string
  before: { realizedPnlUsd: number; feesPaidUsd: number; netPnlUsd: number }
  after: { realizedPnlUsd: number; feesPaidUsd: number; netPnlUsd: number }
  updatedSlices: number
  unmatchedSlices: number
}

async function main() {
  console.log(`[Reconcile] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}${TARGET_ID ? ` target=#${TARGET_ID}` : ''}`)

  const creds = await getCreds()
  if (!creds) throw new Error('No Binance creds')
  const serverOffset = await syncServerTime(creds)
  console.log(`[Reconcile] net=${creds.net} serverOffset=${serverOffset}ms`)

  const rows = await prisma.breakoutLiveTradeC.findMany({
    where: {
      ...(TARGET_ID ? { id: TARGET_ID } : {
        status: { in: ['CLOSED', 'SL_HIT', 'TP3_HIT', 'EXPIRED'] },
      }),
      NOT: { closes: { equals: [] } },
    },
    orderBy: { closedAt: 'asc' },
  })
  console.log(`[Reconcile] candidate rows: ${rows.length}`)

  const reports: FixReport[] = []
  const symbolCache = new Map<string, UserTrade[]>()

  for (const t of rows) {
    const closes = ((t.closes as any[]) ?? []) as CloseEntry[]
    if (closes.length === 0) continue
    const needsFix = closes.some((c) => Number(c?.pnlUsd ?? 0) === 0 && Number(c?.percent ?? 0) > 0)
    if (!needsFix) continue

    const openedMs = new Date(t.openedAt).getTime()
    const closedMs = t.closedAt ? new Date(t.closedAt).getTime() : Date.now()

    // Pull userTrades for the symbol once, covering the full span of all
    // candidate rows for that symbol.
    let symbolTrades = symbolCache.get(t.symbol)
    if (!symbolTrades) {
      symbolTrades = []
      const candidatesForSym = rows.filter((r) => r.symbol === t.symbol)
      const startMs = Math.min(...candidatesForSym.map((r) => new Date(r.openedAt).getTime())) - 60_000
      const endMs = Math.max(...candidatesForSym.map((r) => r.closedAt ? new Date(r.closedAt).getTime() : Date.now())) + 5 * 60_000
      try {
        // Binance limits userTrades to a 7-day window per call and 1000 rows.
        const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000
        let winStart = startMs
        while (winStart < endMs) {
          const winEnd = Math.min(winStart + ONE_WEEK_MS - 1, endMs)
          const batch = await getUserTrades(creds, t.symbol, winStart, winEnd, serverOffset)
          symbolTrades.push(...batch)
          if (batch.length < 1000) {
            winStart = winEnd + 1
          } else {
            // 1000 rows hit — advance by the last trade's time to avoid skipping.
            winStart = batch[batch.length - 1].time + 1
          }
        }
        symbolCache.set(t.symbol, symbolTrades)
        console.log(`[Reconcile] ${t.symbol}: pulled ${symbolTrades.length} userTrades`)
      } catch (e: any) {
        console.warn(`[Reconcile] ${t.symbol}: userTrades failed: ${e.message}`)
        continue
      }
    }

    const exitSide: 'BUY' | 'SELL' = t.side === 'BUY' ? 'SELL' : 'BUY'
    const winFills = symbolTrades.filter(
      (f) => f.side === exitSide && f.time >= openedMs && f.time <= closedMs + 5 * 60_000,
    )
    if (winFills.length === 0) {
      console.warn(`[Reconcile] #${t.id} ${t.symbol} ${t.side}: no userTrades in window — skip`)
      continue
    }

    // Group fills by orderId (one MARKET = many fills can share an orderId).
    interface OrderGroup { orderId: number; time: number; qty: number; commission: number; realizedPnl: number; pxQty: number }
    const groupsMap = new Map<number, OrderGroup>()
    for (const f of winFills) {
      const g = groupsMap.get(f.orderId) ?? { orderId: f.orderId, time: f.time, qty: 0, commission: 0, realizedPnl: 0, pxQty: 0 }
      const qty = Number(f.qty)
      g.qty += qty
      g.commission += Number(f.commission)
      g.realizedPnl += Number(f.realizedPnl)
      g.pxQty += Number(f.price) * qty
      g.time = Math.min(g.time, f.time)
      groupsMap.set(f.orderId, g)
    }
    const groups = Array.from(groupsMap.values()).sort((a, b) => a.time - b.time)

    const sortedClosesIdx = closes
      .map((c, i) => ({ c, i }))
      .sort((a, b) => new Date(a.c.closedAt ?? 0).getTime() - new Date(b.c.closedAt ?? 0).getTime())

    let groupCursor = 0
    let qtyConsumedInGroup = 0
    let updatedSlices = 0
    let unmatchedSlices = 0
    const newCloses: CloseEntry[] = [...closes]

    for (const { i } of sortedClosesIdx) {
      const c = closes[i]
      const plannedQty = (t.positionUnits * (Number(c.percent) || 0)) / 100
      if (plannedQty <= 0) continue

      let remaining = plannedQty
      let sumPnl = 0
      let sumFee = 0
      let sumPxQty = 0
      let sumQty = 0
      while (remaining > 1e-9 && groupCursor < groups.length) {
        const g = groups[groupCursor]
        const avail = g.qty - qtyConsumedInGroup
        if (avail <= 1e-9) {
          groupCursor++
          qtyConsumedInGroup = 0
          continue
        }
        const take = Math.min(avail, remaining)
        const frac = take / g.qty
        sumPnl += g.realizedPnl * frac
        sumFee += g.commission * frac
        sumPxQty += (g.pxQty / g.qty) * take
        sumQty += take
        qtyConsumedInGroup += take
        remaining -= take
        if (Math.abs(g.qty - qtyConsumedInGroup) < 1e-9) {
          groupCursor++
          qtyConsumedInGroup = 0
        }
      }
      if (sumQty <= 1e-9) {
        unmatchedSlices++
        continue
      }
      const avgPx = sumPxQty / sumQty

      // Keep slices that already have a non-zero pnlUsd (refined correctly
      // before the bug) — just advance the fill cursor through their qty.
      if (Number(c.pnlUsd ?? 0) !== 0) continue

      newCloses[i] = {
        ...c,
        price: avgPx > 0 ? avgPx : c.price,
        pnlUsd: sumPnl,
        feePaidUsd: sumFee,
      }
      updatedSlices++
    }

    if (updatedSlices === 0) continue

    const beforeReport = {
      realizedPnlUsd: t.realizedPnlUsd ?? 0,
      feesPaidUsd: t.feesPaidUsd ?? 0,
      netPnlUsd: t.netPnlUsd ?? 0,
    }

    if (APPLY) {
      await prisma.breakoutLiveTradeC.update({
        where: { id: t.id },
        data: { closes: newCloses as any },
      })
      await recomputeRow(t.id)
    }

    // Preview totals for the report (works in both modes).
    const closesFees = newCloses.reduce((a, c) => a + (Number(c?.feePaidUsd) || 0), 0)
    const realizedSum = newCloses.reduce((a, c) => a + (Number(c?.pnlUsd) || 0), 0)
    const totalFees = (t.entryFeeUsd ?? 0) + closesFees
    const netAfter = realizedSum - totalFees - (t.fundingPaidUsd ?? 0)

    reports.push({
      tradeId: t.id,
      symbol: t.symbol,
      side: t.side,
      status: t.status,
      before: beforeReport,
      after: { realizedPnlUsd: realizedSum, feesPaidUsd: totalFees, netPnlUsd: netAfter },
      updatedSlices,
      unmatchedSlices,
    })
  }

  console.log(`\n[Reconcile] ${reports.length} row(s) ${APPLY ? 'updated' : 'would be updated'}:`)
  console.log('  id    | sym          | side | status  |  net before  →  net after    |    Δ      | slices')
  console.log('  ------+--------------+------+---------+------------------------------+-----------+--------')
  let totalDelta = 0
  for (const r of reports) {
    const delta = r.after.netPnlUsd - r.before.netPnlUsd
    totalDelta += delta
    console.log(
      `  ${String(r.tradeId).padEnd(5)} | ${r.symbol.padEnd(12)} | ${r.side.padEnd(4)} | ${r.status.padEnd(7)} | ${r.before.netPnlUsd.toFixed(2).padStart(10)}  →  ${r.after.netPnlUsd.toFixed(2).padStart(10)} | ${((delta >= 0 ? '+' : '') + delta.toFixed(2)).padStart(9)} | ${r.updatedSlices}+${r.unmatchedSlices}`,
    )
  }
  console.log(`\n[Reconcile] total net P&L delta: ${totalDelta >= 0 ? '+' : ''}${totalDelta.toFixed(2)} USDT`)

  if (APPLY && reports.length > 0) {
    await recomputeConfig()
    console.log('[Reconcile] BreakoutLiveConfigC aggregates recomputed')
  }
  if (!APPLY) {
    console.log('[Reconcile] dry-run — pass --apply to write changes')
  }

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('[Reconcile] FAILED:', e)
  process.exit(1)
})
