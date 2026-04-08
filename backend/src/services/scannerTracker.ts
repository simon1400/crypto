import { prisma } from '../db/prisma'
import { fetchCurrentPrice } from './market'

// Tracks SCANNER trades every 2 seconds:
// 1. PENDING_ENTRY — waits for price to reach or cross entry, then activates
// 2. OPEN/PARTIALLY_CLOSED — monitors SL/TP levels, auto-closes

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
        // Cancel if price already past SL
        const pastSL = isLong ? price <= trade.stopLoss : price >= trade.stopLoss
        if (pastSL) {
          await prisma.trade.update({
            where: { id: trade.id },
            data: { status: 'CANCELLED', closedAt: new Date() },
          })
          console.log(`[ScannerTracker] ${trade.coin} cancelled — price $${price} past SL $${trade.stopLoss}`)
          continue
        }

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
        }
        lastPrices[trade.coin] = price
        continue
      }

      // === Phase 2: Track SL/TP ===
      const tps = trade.takeProfits as { price: number; percent: number }[]

      // Check SL
      const slHit = isLong ? price <= trade.stopLoss : price >= trade.stopLoss
      if (slHit) {
        await closeTradePortion(trade, trade.stopLoss, 100 - trade.closedPct, true)
        console.log(`[ScannerTracker] ${trade.coin} SL hit at $${trade.stopLoss} (price: $${price})`)
        lastPrices[trade.coin] = price
        continue
      }

      // Check TPs from highest to lowest
      const sortedTps = [...tps].sort((a, b) => isLong ? b.price - a.price : a.price - b.price)

      for (const tp of sortedTps) {
        const tpHit = isLong ? price >= tp.price : price <= tp.price
        if (tpHit) {
          const closes = (trade.closes as any[]) || []
          const alreadyClosed = closes.some(c => Math.abs(c.price - tp.price) < 0.0001 && !c.isSL)
          if (alreadyClosed) continue

          const pctToClose = Math.min(tp.percent, 100 - trade.closedPct)
          if (pctToClose <= 0) continue

          await closeTradePortion(trade, tp.price, pctToClose, false)
          console.log(`[ScannerTracker] ${trade.coin} TP hit at $${tp.price} (${pctToClose}%)`)

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

  const closes = Array.isArray(trade.closes) ? [...trade.closes] : []
  closes.push({
    price: closePrice,
    percent,
    pnl: Math.round(pnlUsdt * 100) / 100,
    pnlPercent: Math.round(pnlPercent * 100) / 100,
    closedAt: new Date().toISOString(),
    isSL,
  })

  const newClosedPct = Math.min(100, trade.closedPct + percent)
  const newRealizedPnl = Math.round((trade.realizedPnl + pnlUsdt) * 100) / 100
  const isFull = newClosedPct >= 100

  await prisma.trade.update({
    where: { id: trade.id },
    data: {
      closes,
      closedPct: newClosedPct,
      realizedPnl: newRealizedPnl,
      status: isSL ? 'SL_HIT' : (isFull ? 'CLOSED' : 'PARTIALLY_CLOSED'),
      closedAt: isFull || isSL ? new Date() : null,
    },
  })
}
