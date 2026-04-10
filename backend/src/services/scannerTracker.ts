import { prisma } from '../db/prisma'
import { fetchCurrentPrice } from './market'
import { adjustVirtualBalance } from './virtualBalance'
import { calcExitFee } from './fees'

// Tracks SCANNER trades every 2 seconds:
// 1. PENDING_ENTRY — waits for price to reach or cross entry, then activates
// 2. OPEN/PARTIALLY_CLOSED — monitors SL/TP levels, auto-closes
// 3. ENTRY_ANALYZER pairs — auto-merges when both entries fill

// Store last known price per coin to detect crossings
const lastPrices: Record<string, number> = {}

export async function trackScannerTrades() {
  const trades = await prisma.trade.findMany({
    where: {
      status: { in: ['PENDING_ENTRY', 'OPEN', 'PARTIALLY_CLOSED'] },
    },
  })

  if (!trades.length) return

  // Fetch prices for all unique coins in parallel
  const coins = [...new Set(trades.map(t => t.coin))]
  const prices: Record<string, number | null> = {}
  await Promise.all(coins.map(async coin => {
    prices[coin] = await fetchCurrentPrice(coin)
  }))

  for (const trade of trades) {
    try {
      const price = prices[trade.coin]
      if (!price) continue

      const isLong = trade.type === 'LONG'
      const prevPrice = lastPrices[trade.coin]

      // === Phase 1: Wait for entry fill ===
      if (trade.status === 'PENDING_ENTRY') {
        // Entry fills when price equals or crosses entry level
        let entryFilled = false
        if (prevPrice != null) {
          // Price crossed entry between ticks
          if (isLong) {
            // LONG limit: price was above entry, now at or below
            entryFilled = prevPrice > trade.entryPrice && price <= trade.entryPrice
          } else {
            // SHORT limit: price was below entry, now at or above
            entryFilled = prevPrice < trade.entryPrice && price >= trade.entryPrice
          }
        }
        // Also fill if price exactly equals entry
        if (price === trade.entryPrice) entryFilled = true

        if (entryFilled) {
          await prisma.trade.update({
            where: { id: trade.id },
            data: { status: 'OPEN', openedAt: new Date() },
          })
          console.log(`[ScannerTracker] ${trade.coin} entry filled at $${price} (target $${trade.entryPrice})`)

          // Check if this is an ENTRY_ANALYZER pair — auto-merge if both filled
          if (trade.source === 'ENTRY_ANALYZER' && trade.notes) {
            await tryMergeEntryPair(trade.id, trade.notes)
          }
        }
        lastPrices[trade.coin] = price
        continue
      }

      // === Phase 2: Track SL/TP with Trailing Stop ===
      const tps = trade.takeProfits as { price: number; percent: number }[]
      const closes = (trade.closes as any[]) || []

      // Determine how many TPs already hit (for trailing SL)
      const tpsSortedByPrice = [...tps].sort((a, b) => isLong ? a.price - b.price : b.price - a.price)
      let tpsHitCount = 0
      for (const tp of tpsSortedByPrice) {
        const alreadyClosed = closes.some(c => Math.abs(c.price - tp.price) < 0.0001 && !c.isSL)
        if (alreadyClosed) tpsHitCount++
        else break
      }

      // Trailing SL: TP1 hit → SL = entry (BE), TP2 hit → SL = TP1, TPn hit → SL = TP(n-1)
      let effectiveSL = trade.stopLoss
      if (tpsHitCount === 1) {
        effectiveSL = trade.entryPrice
      } else if (tpsHitCount >= 2) {
        effectiveSL = tpsSortedByPrice[tpsHitCount - 2].price
      }

      // Check SL (using effective trailing SL)
      const slHit = isLong ? price <= effectiveSL : price >= effectiveSL
      if (slHit) {
        await closeTradePortion(trade, effectiveSL, 100 - trade.closedPct, true)
        const label = tpsHitCount > 0 ? `trailing SL (after TP${tpsHitCount})` : 'SL'
        console.log(`[ScannerTracker] ${trade.coin} ${label} hit at $${effectiveSL} (price: $${price})`)
        lastPrices[trade.coin] = price
        continue
      }

      // Check TPs from highest to lowest
      const sortedTps = [...tps].sort((a, b) => isLong ? b.price - a.price : a.price - b.price)

      for (const tp of sortedTps) {
        const tpHit = isLong ? price >= tp.price : price <= tp.price
        if (tpHit) {
          const alreadyClosed = closes.some(c => Math.abs(c.price - tp.price) < 0.0001 && !c.isSL)
          if (alreadyClosed) continue

          const pctToClose = Math.min(tp.percent, 100 - trade.closedPct)
          if (pctToClose <= 0) continue

          await closeTradePortion(trade, tp.price, pctToClose, false)

          // Determine which TP number was hit
          const tpIndex = tpsSortedByPrice.findIndex(t => Math.abs(t.price - tp.price) < 0.0001)
          const tpNum = tpIndex >= 0 ? tpIndex + 1 : '?'
          const newTpsHit = tpsHitCount + 1
          let newSL = trade.entryPrice
          if (newTpsHit >= 2) newSL = tpsSortedByPrice[0].price
          console.log(`[ScannerTracker] ${trade.coin} TP${tpNum} hit at $${tp.price} (${pctToClose}%) → trailing SL moved to $${newSL}`)

          const updated = await prisma.trade.findUnique({ where: { id: trade.id } })
          if (updated) Object.assign(trade, updated)

          break
        }
      }

      lastPrices[trade.coin] = price
    } catch (err) {
      console.error(`[ScannerTracker] Error tracking ${trade.coin}:`, err)
    }
  }
}

// Auto-merge ENTRY_ANALYZER pair when both entries are filled
async function tryMergeEntryPair(filledTradeId: number, notes: string) {
  // Extract group ID from notes: "group:EA-1234567890 | ..."
  const groupMatch = notes.match(/group:(EA-\d+)/)
  if (!groupMatch) return

  const groupId = groupMatch[1]

  // Find all trades in this group
  const groupTrades = await prisma.trade.findMany({
    where: {
      source: 'ENTRY_ANALYZER',
      notes: { contains: `group:${groupId}` },
    },
  })

  if (groupTrades.length !== 2) return

  // Both must be OPEN (just filled)
  const allOpen = groupTrades.every(t => t.status === 'OPEN')
  if (!allOpen) return

  const [t1, t2] = groupTrades.sort((a, b) => a.id - b.id)

  // Calculate weighted average entry
  const totalAmount = t1.amount + t2.amount
  const avgEntry = Math.round(((t1.entryPrice * t1.amount + t2.entryPrice * t2.amount) / totalAmount) * 10000) / 10000

  // Recalculate TP R:R from averaged entry
  const tps = t1.takeProfits as any[]
  const riskAmount = Math.abs(avgEntry - t1.stopLoss)
  const direction = t1.type === 'LONG' ? 1 : -1
  const newTPs = tps.map((tp: any) => ({
    price: tp.price,
    percent: tp.percent,
    rr: riskAmount > 0 ? Math.round(((tp.price - avgEntry) * direction / riskAmount) * 100) / 100 : 0,
  }))

  // Delete both old trades
  await prisma.trade.deleteMany({ where: { id: { in: [t1.id, t2.id] } } })

  // Create merged trade — переносим суммарные fees (entry fees уже были списаны)
  const merged = await prisma.trade.create({
    data: {
      coin: t1.coin,
      type: t1.type,
      leverage: t1.leverage,
      entryPrice: avgEntry,
      amount: totalAmount,
      stopLoss: t1.stopLoss,
      takeProfits: newTPs,
      status: 'OPEN',
      source: 'ENTRY_ANALYZER',
      entryOrderType: t1.entryOrderType,
      fees: t1.fees + t2.fees,
      fundingPaid: t1.fundingPaid + t2.fundingPaid,
      openedAt: new Date(),
      notes: `Merged ${groupId}: #${t1.id} ($${t1.entryPrice}) + #${t2.id} ($${t2.entryPrice}) → avg $${avgEntry}`,
    },
  })

  console.log(`[ScannerTracker] Auto-merged ${groupId}: #${t1.id} + #${t2.id} → #${merged.id} (avg entry: $${avgEntry}, total: $${totalAmount})`)
}

async function closeTradePortion(
  trade: any,
  closePrice: number,
  percent: number,
  isSL: boolean,
) {
  const direction = trade.type === 'LONG' ? 1 : -1
  const priceDiff = (closePrice - trade.entryPrice) * direction
  const pnlPercent = (priceDiff / trade.entryPrice) * 100 * trade.leverage
  const portionAmount = trade.amount * (percent / 100)
  const pnlUsdt = portionAmount * (pnlPercent / 100)

  // Авто-закрытие на TP/SL = market = taker fee
  const exitFee = await calcExitFee(portionAmount, trade.leverage)

  await adjustVirtualBalance(
    portionAmount + pnlUsdt - exitFee,
    `${isSL ? 'auto-SL' : 'auto-TP'} ${trade.coin} #${trade.id} pnl=${pnlUsdt.toFixed(2)} fee=${exitFee.toFixed(4)}`,
  )

  const closes = Array.isArray(trade.closes) ? [...trade.closes] : []
  closes.push({
    price: closePrice,
    percent,
    pnl: Math.round(pnlUsdt * 100) / 100,
    pnlPercent: Math.round(pnlPercent * 100) / 100,
    fee: Math.round(exitFee * 1e6) / 1e6,
    closedAt: new Date().toISOString(),
    isSL,
  })

  const newClosedPct = Math.min(100, trade.closedPct + percent)
  const newRealizedPnl = Math.round((trade.realizedPnl + pnlUsdt) * 100) / 100
  const newFees = Math.round((trade.fees + exitFee) * 1e6) / 1e6
  const isFull = newClosedPct >= 100

  await prisma.trade.update({
    where: { id: trade.id },
    data: {
      closes,
      closedPct: newClosedPct,
      realizedPnl: newRealizedPnl,
      fees: newFees,
      status: isSL ? 'SL_HIT' : (isFull ? 'CLOSED' : 'PARTIALLY_CLOSED'),
      closedAt: isFull || isSL ? new Date() : null,
    },
  })
}
