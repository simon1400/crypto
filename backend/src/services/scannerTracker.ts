import { prisma } from '../db/prisma'
import { fetchPricesBatch } from './market'
import { closeTradePortion, computePortionPnl } from './tradeClose'
import { sendNotification } from './notifier'

// Tracks SCANNER trades every 2 seconds:
// 1. PENDING_ENTRY — waits for price to reach or cross entry, then activates
// 2. OPEN/PARTIALLY_CLOSED — monitors SL/TP levels, auto-closes
//    Also: MFE/MAE tracking, time-stop enforcement
// 3. ENTRY_ANALYZER pairs — auto-merges when both entries fill

const lastPrices: Record<string, number> = {}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}м`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h < 24) return m > 0 ? `${h}ч ${m}м` : `${h}ч`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return rh > 0 ? `${d}д ${rh}ч` : `${d}д`
}

function computeSlPnl(trade: any, slPrice: number) {
  const remaining = 100 - trade.closedPct
  return computePortionPnl(trade, slPrice, remaining)
}

// Time-stop disabled — trades close only via SL, TP, or manual action

export async function trackScannerTrades() {
  const trades = await prisma.trade.findMany({
    where: {
      status: { in: ['PENDING_ENTRY', 'OPEN', 'PARTIALLY_CLOSED'] },
    },
  })

  if (!trades.length) return

  const prices = await fetchPricesBatch(trades.map(t => t.coin))

  const pendingMfeUpdates: { id: number; mfe: number; mae: number }[] = []

  for (const trade of trades) {
    try {
      const price = prices[trade.coin]
      if (!price) continue

      const isLong = trade.type === 'LONG'
      const prevPrice = lastPrices[trade.coin]

      // === Phase 1: Wait for entry fill ===
      if (trade.status === 'PENDING_ENTRY') {
        let entryFilled = false
        if (prevPrice != null) {
          if (isLong) {
            entryFilled = prevPrice > trade.entryPrice && price <= trade.entryPrice
          } else {
            entryFilled = prevPrice < trade.entryPrice && price >= trade.entryPrice
          }
        }
        if (price === trade.entryPrice) entryFilled = true

        if (entryFilled) {
          await prisma.trade.update({
            where: { id: trade.id },
            data: {
              status: 'OPEN',
              openedAt: new Date(),
              // Populate initial_stop = current stopLoss at entry time
              initialStop: trade.initialStop ?? trade.stopLoss,
              currentStop: trade.stopLoss,
            },
          })
          console.log(`[ScannerTracker] ${trade.coin} entry filled at $${price} (target $${trade.entryPrice})`)

          const tps = trade.takeProfits as { price: number; percent: number }[]
          sendNotification('ORDER_FILLED', {
            symbol: trade.coin,
            type: trade.type,
            leverage: trade.leverage,
            entryPrice: trade.entryPrice,
            stopLoss: trade.stopLoss,
            margin: trade.amount,
            takeProfits: tps,
          }).catch(() => {})

          if (trade.source === 'ENTRY_ANALYZER' && trade.notes) {
            await tryMergeEntryPair(trade.id, trade.notes)
          }
        }
        lastPrices[trade.coin] = price
        continue
      }

      // === Phase 2: Track SL/TP + MFE/MAE + Time-stop ===
      const tps = trade.takeProfits as { price: number; percent: number }[]
      const closes = (trade.closes as any[]) || []

      // --- MFE/MAE tracking ---
      const direction = isLong ? 1 : -1
      const excursionPct = ((price - trade.entryPrice) / trade.entryPrice) * 100 * direction
      const currentMfe = trade.mfe ?? 0
      const currentMae = trade.mae ?? 0
      const newMfe = Math.max(currentMfe, excursionPct)
      const newMae = Math.min(currentMae, excursionPct)

      if (newMfe !== currentMfe || newMae !== currentMae) {
        pendingMfeUpdates.push({
          id: trade.id,
          mfe: Math.round(newMfe * 100) / 100,
          mae: Math.round(newMae * 100) / 100,
        })
      }

      // --- Determine trailing SL ---
      const tpsSortedByPrice = [...tps].sort((a, b) => isLong ? a.price - b.price : b.price - a.price)
      let tpsHitCount = 0
      for (const tp of tpsSortedByPrice) {
        // Use relative threshold (0.5% of price) instead of absolute — safe for low-price coins
        const threshold = tp.price * 0.005
        const alreadyClosed = closes.some(c => Math.abs(c.price - tp.price) < threshold && !c.isSL)
        if (alreadyClosed) tpsHitCount++
        else break
      }

      let effectiveSL = trade.stopLoss
      if (tpsHitCount === 1) {
        effectiveSL = trade.entryPrice
      } else if (tpsHitCount >= 2) {
        effectiveSL = tpsSortedByPrice[tpsHitCount - 2].price
      }

      // --- Time-stop check ---
      const openTime = trade.openedAt?.getTime() || trade.createdAt.getTime()
      const hoursOpen = (Date.now() - openTime) / (1000 * 60 * 60)
      const riskAmount = Math.abs(trade.entryPrice - (trade.initialStop ?? trade.stopLoss))
      const progressR = riskAmount > 0 ? (excursionPct / 100 * trade.entryPrice) / riskAmount : 0

      // Time-stop disabled — trades close only via SL, TP, or manual action

      // --- SL check ---
      const slHit = isLong ? price <= effectiveSL : price >= effectiveSL
      if (slHit) {
        await closeTradePortion(trade, {
          price: effectiveSL,
          percent: 100 - trade.closedPct,
          isSL: true,
          forceFullClose: true,
          exitReason: tpsHitCount > 0
            ? (trade.trailingActivated ? 'TRAILING_STOP' : 'BE_STOP')
            : 'INITIAL_STOP',
          logContext: `auto-SL ${trade.coin} #${trade.id}`,
        })
        const label = tpsHitCount > 0 ? `trailing SL (after TP${tpsHitCount})` : 'SL'
        console.log(`[ScannerTracker] ${trade.coin} ${label} hit at $${effectiveSL} (price: $${price})`)

        const slExitReason = tpsHitCount > 0
          ? (trade.trailingActivated ? 'TRAILING_STOP' : 'BE_STOP')
          : 'INITIAL_STOP'
        const slUpdated = await prisma.trade.findUnique({ where: { id: trade.id } })
        if (slUpdated) {
          const slPnl = computeSlPnl(trade, effectiveSL)
          const timeMin = slUpdated.timeInTradeMin ?? 0
          sendNotification('SL_TRIGGERED', {
            symbol: trade.coin,
            type: trade.type,
            leverage: trade.leverage,
            price: effectiveSL,
            pnl: slUpdated.realizedPnl,
            pnlPct: trade.amount > 0 ? (slUpdated.realizedPnl / trade.amount) * 100 : 0,
            totalRealizedPnl: slUpdated.realizedPnl,
            totalFees: slUpdated.fees,
            exitReason: slExitReason,
            timeInTrade: formatDuration(timeMin),
          }).catch(() => {})
        }

        lastPrices[trade.coin] = price
        continue
      }

      // --- TP check (from lowest to highest — TP1 first so trailing SL activates correctly) ---
      const sortedTps = [...tps].sort((a, b) => isLong ? a.price - b.price : b.price - a.price)

      for (const tp of sortedTps) {
        const tpHit = isLong ? price >= tp.price : price <= tp.price
        if (tpHit) {
          const threshold = tp.price * 0.005
          const alreadyClosed = closes.some(c => Math.abs(c.price - tp.price) < threshold && !c.isSL)
          if (alreadyClosed) continue

          const pctToClose = Math.min(tp.percent, 100 - trade.closedPct)
          if (pctToClose <= 0) continue

          // Determine TP number
          const tpIndex = tpsSortedByPrice.findIndex(t => Math.abs(t.price - tp.price) < 0.0001)
          const tpNum = tpIndex >= 0 ? tpIndex + 1 : 0

          await closeTradePortion(trade, {
            price: tp.price,
            percent: pctToClose,
            tpNumber: tpNum,
            exitReason: tpNum === tps.length ? 'TP3_FINAL' : `TP${tpNum}_PARTIAL`,
            logContext: `auto-TP${tpNum} ${trade.coin} #${trade.id}`,
          })

          const updated = await prisma.trade.findUnique({ where: { id: trade.id } })
          if (updated) Object.assign(trade, updated)
          console.log(`[ScannerTracker] ${trade.coin} TP${tpNum} hit at $${tp.price} (${pctToClose}%) → SL=$${updated?.stopLoss}`)

          if (updated) {
            const isFull = updated.closedPct >= 100
            const tpAction = `TP${tpNum}_HIT` as any
            const lastClose = (updated.closes as any[])?.slice(-1)[0]
            sendNotification(tpAction, {
              symbol: trade.coin,
              type: trade.type,
              leverage: trade.leverage,
              price: tp.price,
              closedPct: pctToClose,
              pnlPct: lastClose?.pnlPercent ?? 0,
              pnl: lastClose?.pnl ?? 0,
              fee: lastClose?.fee ?? 0,
              totalRealizedPnl: updated.realizedPnl,
              remainingPct: Math.round(100 - updated.closedPct),
              newStopLoss: updated.stopLoss,
            }).catch(() => {})

            if (isFull) {
              const timeMin = updated.timeInTradeMin ?? 0
              const netPnl = updated.realizedPnl - updated.fees - (updated.fundingPaid || 0)
              sendNotification('POSITION_CLOSED', {
                symbol: trade.coin,
                type: trade.type,
                leverage: trade.leverage,
                totalRealizedPnl: updated.realizedPnl,
                totalFees: updated.fees,
                netPnl,
                timeInTrade: formatDuration(timeMin),
              }).catch(() => {})
            }
          }

          break
        }
      }

      lastPrices[trade.coin] = price
    } catch (err) {
      console.error(`[ScannerTracker] Error tracking ${trade.coin}:`, err)
    }
  }

  // Flush all MFE/MAE updates in a single batch transaction (O(1) instead of O(n))
  if (pendingMfeUpdates.length > 0) {
    await prisma.$transaction(
      pendingMfeUpdates.map(u =>
        prisma.trade.update({
          where: { id: u.id },
          data: { mfe: u.mfe, mae: u.mae },
        })
      )
    )
  }
}

// Auto-merge ENTRY_ANALYZER pair when both entries are filled
async function tryMergeEntryPair(_filledTradeId: number, notes: string) {
  const groupMatch = notes.match(/group:(EA-\d+)/)
  if (!groupMatch) return

  const groupId = groupMatch[1]

  const groupTrades = await prisma.trade.findMany({
    where: {
      source: 'ENTRY_ANALYZER',
      notes: { contains: `group:${groupId}` },
    },
  })

  if (groupTrades.length !== 2) return

  const allOpen = groupTrades.every(t => t.status === 'OPEN')
  if (!allOpen) return

  const [t1, t2] = groupTrades.sort((a, b) => a.id - b.id)

  const totalAmount = t1.amount + t2.amount
  const avgEntry = Math.round(((t1.entryPrice * t1.amount + t2.entryPrice * t2.amount) / totalAmount) * 10000) / 10000

  const tps = t1.takeProfits as any[]
  const riskAmount = Math.abs(avgEntry - t1.stopLoss)
  const direction = t1.type === 'LONG' ? 1 : -1
  const newTPs = tps.map((tp: any) => ({
    price: tp.price,
    percent: tp.percent,
    rr: riskAmount > 0 ? Math.round(((tp.price - avgEntry) * direction / riskAmount) * 100) / 100 : 0,
  }))

  const scoreMatch = (t1.notes || t2.notes || '').match(/Score:\s*(\d+)/)
  const scorePart = scoreMatch ? ` | Score: ${scoreMatch[1]}` : ''

  const merged = await prisma.$transaction(async (tx) => {
    await tx.trade.deleteMany({ where: { id: { in: [t1.id, t2.id] } } })
    return tx.trade.create({
      data: {
        coin: t1.coin,
        type: t1.type,
        leverage: t1.leverage,
        entryPrice: avgEntry,
        amount: totalAmount,
        stopLoss: t1.stopLoss,
        initialStop: t1.stopLoss,
        currentStop: t1.stopLoss,
        takeProfits: newTPs,
        status: 'OPEN',
        source: 'ENTRY_ANALYZER',
        entryOrderType: t1.entryOrderType,
        fees: t1.fees + t2.fees,
        fundingPaid: t1.fundingPaid + t2.fundingPaid,
        openedAt: new Date(),
        notes: `Merged ${groupId}: #${t1.id} ($${t1.entryPrice}) + #${t2.id} ($${t2.entryPrice}) → avg $${avgEntry}${scorePart}`,
      },
    })
  })

  console.log(`[ScannerTracker] Auto-merged ${groupId}: #${t1.id} + #${t2.id} → #${merged.id} (avg entry: $${avgEntry}, total: $${totalAmount})`)
}
