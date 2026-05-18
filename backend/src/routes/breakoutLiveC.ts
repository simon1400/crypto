/**
 * Variant C LIVE — Binance Futures real-money paper-trader twin.
 *
 * Endpoints under /api/breakout-live-c:
 *   GET  /config              → BreakoutLiveConfigC (current state)
 *   PUT  /config              → update enabled / risk / fees / circuit breaker / sizing
 *   GET  /status              → live connectivity check (Binance ping, balance, open positions)
 *   GET  /trades              → paginated trade list
 *   GET  /trades/live         → live un/realized for open positions (mark price from Binance)
 *   POST /kill-switch         → cancel all open orders + close all positions market + disable
 *   POST /test-place-order    → manual sanity check: place a tiny LIMIT far from market (testnet ONLY)
 *   DELETE /test-orders       → cancel all open test orders for a symbol
 *
 * Day-1 minimal surface: focused on giving the user a visible "the code can talk
 * to Binance" feedback loop before we wire the strategy in.
 */

import { Router } from 'express'
import { prisma } from '../db/prisma'
import {
  getBinanceClient, getBinanceCreds, BinanceApiError,
} from '../services/exchanges/binanceFutures'
import { refreshLiveBalance } from './_liveBalanceShared'
import { flattenAllOpenLiveC } from '../services/dailyBreakoutLiveTraderC'

// Re-export so existing import paths (`from './breakoutLiveC'`) keep working.
export { refreshLiveBalance }

const router = Router()


// ============================================================================
// Config
// ============================================================================

router.get('/config', async (_req, res) => {
  try {
    const cfg = await prisma.breakoutLiveConfigC.upsert({
      where: { id: 1 }, update: {}, create: { id: 1 },
    })
    res.json(cfg)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.put('/config', async (req, res) => {
  try {
    const {
      enabled, useTestnet, riskPctPerTrade,
      feeTakerPct, feeMakerPct, slipTakerPct,
      autoTrailingSL, targetMarginPct, marginGuardEnabled, marginGuardAutoClose,
      dailyLossLimitPct, dailyLossLimitR, weeklyLossLimitPct,
      maxConcurrentPositions, maxPositionsPerSymbol,
    } = req.body

    // Baseline snapshot: the first time Strategy is enabled, capture the
    // current Binance available balance as startingDepositUsd. This becomes the
    // reference point for Total P&L going forward. resetAt marks the snapshot
    // time so we can show "since {date}" in the UI.
    let baselineSnapshot: { startingDepositUsd: number; resetAt: Date } | null = null
    if (enabled === true) {
      const current = await prisma.breakoutLiveConfigC.findUnique({ where: { id: 1 } })
      if (current && !current.resetAt) {
        const creds = await getBinanceCreds(useTestnet ?? current.useTestnet)
        if (creds) {
          try {
            const client = getBinanceClient(creds)
            await client.syncTime()
            const acc = await client.getAccount()
            const usdt = acc.assets.find((a) => a.asset === 'USDT')
            const avail = usdt ? Number(usdt.availableBalance) : 0
            if (avail > 0) {
              baselineSnapshot = {
                startingDepositUsd: avail,
                resetAt: new Date(),
              }
            }
          } catch (e: any) {
            // If we can't reach Binance at the enable moment, refuse to enable
            // rather than start with a stale baseline.
            return res.status(400).json({
              error: `Не могу снимать baseline: ${e.message}. Проверь подключение и попробуй снова.`,
            })
          }
        }
      }
    }

    const cfg = await prisma.breakoutLiveConfigC.update({
      where: { id: 1 },
      data: {
        ...(baselineSnapshot ? {
          startingDepositUsd: baselineSnapshot.startingDepositUsd,
          currentDepositUsd: baselineSnapshot.startingDepositUsd,
          peakDepositUsd: baselineSnapshot.startingDepositUsd,
          resetAt: baselineSnapshot.resetAt,
        } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        ...(useTestnet !== undefined ? { useTestnet } : {}),
        ...(riskPctPerTrade !== undefined ? { riskPctPerTrade } : {}),
        ...(feeTakerPct !== undefined ? { feeTakerPct } : {}),
        ...(feeMakerPct !== undefined ? { feeMakerPct } : {}),
        ...(slipTakerPct !== undefined ? { slipTakerPct } : {}),
        ...(autoTrailingSL !== undefined ? { autoTrailingSL } : {}),
        ...(targetMarginPct !== undefined ? { targetMarginPct } : {}),
        ...(marginGuardEnabled !== undefined ? { marginGuardEnabled } : {}),
        ...(marginGuardAutoClose !== undefined ? { marginGuardAutoClose } : {}),
        ...(dailyLossLimitPct !== undefined ? { dailyLossLimitPct } : {}),
        ...(dailyLossLimitR !== undefined ? { dailyLossLimitR } : {}),
        ...(weeklyLossLimitPct !== undefined ? { weeklyLossLimitPct } : {}),
        ...(maxConcurrentPositions !== undefined ? { maxConcurrentPositions } : {}),
        ...(maxPositionsPerSymbol !== undefined ? { maxPositionsPerSymbol } : {}),
      },
    })
    res.json(cfg)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ============================================================================
// Baseline — set startingDepositUsd = current Binance available balance.
// Used both implicitly (auto-snapshot on first enable) and explicitly via this
// endpoint. Calling reset zeroes out the previous P&L base — useful after
// depositing more USDT to start counting fresh from the new balance.
// ============================================================================

router.post('/baseline/reset', async (_req, res) => {
  try {
    const cfg = await prisma.breakoutLiveConfigC.findUnique({ where: { id: 1 } })
    if (!cfg) return res.status(404).json({ error: 'Config not found' })

    const creds = await getBinanceCreds(cfg.useTestnet)
    if (!creds) return res.status(400).json({ error: 'Binance ключи не настроены. Добавь их в Настройках.' })

    const client = getBinanceClient(creds)
    await client.syncTime()
    const acc = await client.getAccount()
    const usdt = acc.assets.find((a) => a.asset === 'USDT')
    const avail = usdt ? Number(usdt.availableBalance) : 0
    if (avail <= 0) return res.status(400).json({ error: 'На Binance нулевой баланс USDT' })

    const updated = await prisma.breakoutLiveConfigC.update({
      where: { id: 1 },
      data: {
        startingDepositUsd: avail,
        currentDepositUsd: avail,
        peakDepositUsd: avail,
        maxDrawdownPct: 0,
        resetAt: new Date(),
      },
    })
    res.json({ ok: true, baselineUsd: avail, config: updated })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ============================================================================
// Status — connectivity smoke test
// ============================================================================

router.get('/status', async (_req, res) => {
  try {
    const cfg = await prisma.breakoutLiveConfigC.upsert({
      where: { id: 1 }, update: {}, create: { id: 1 },
    })

    const creds = await getBinanceCreds(cfg.useTestnet)
    if (!creds) {
      return res.json({
        connected: false,
        net: cfg.useTestnet ? 'testnet' : 'prod',
        reason: `Binance ${cfg.useTestnet ? 'testnet' : 'live'} ключи не настроены. Добавь их на странице Настройки.`,
        enabled: cfg.enabled,
        killSwitchActive: cfg.killSwitchActive,
      })
    }

    const client = getBinanceClient(creds)
    await client.syncTime()
    const [bal, positions, openOrders] = await Promise.all([
      refreshLiveBalance(client),
      client.getOpenPositions(),
      client.getOpenOrders(),
    ])
    // Baseline for P&L is startingDepositUsd, snapshotted at first enable (see PUT /config).
    // If Strategy has never been turned on, baseline == default ($100) — UI will
    // show that visually (it's expected).
    const baseline = cfg.startingDepositUsd
    const totalPnlUsd = bal.available - baseline
    const totalPnlPct = baseline > 0 ? (totalPnlUsd / baseline) * 100 : 0

    res.json({
      connected: true,
      net: creds.net,
      enabled: cfg.enabled,
      killSwitchActive: cfg.killSwitchActive,
      killSwitchReason: cfg.killSwitchReason,
      // Use 'balanceUsdt' as the canonical current deposit (live Binance source of truth).
      balanceUsdt: bal.available,
      walletBalanceUsdt: bal.total,
      baselineUsd: baseline,
      totalPnlUsd: Math.round(totalPnlUsd * 100) / 100,
      totalPnlPct: Math.round(totalPnlPct * 100) / 100,
      baselineSnapshottedAt: cfg.resetAt,
      openPositions: positions.length,
      openOrders: openOrders.length,
      usedWeight1m: client.usedWeight1m,
      orderCount1m: client.orderCount1m,
      positions: positions.map((p) => ({
        symbol: p.symbol,
        positionAmt: Number(p.positionAmt),
        entryPrice: Number(p.entryPrice),
        markPrice: Number(p.markPrice),
        unRealizedProfit: Number(p.unRealizedProfit),
        leverage: Number(p.leverage),
        marginType: p.marginType,
      })),
      orders: openOrders.map((o) => ({
        orderId: o.orderId,
        clientOrderId: o.clientOrderId,
        symbol: o.symbol,
        side: o.side,
        type: o.type,
        price: Number(o.price),
        stopPrice: Number(o.stopPrice),
        origQty: Number(o.origQty),
        status: o.status,
        reduceOnly: o.reduceOnly,
      })),
    })
  } catch (e: any) {
    const msg = e instanceof BinanceApiError ? e.message : e.message
    res.status(200).json({
      connected: false,
      reason: msg,
    })
  }
})

// ============================================================================
// Trades
// ============================================================================

router.get('/trades', async (req, res) => {
  try {
    const { status, symbol, limit = '100', offset = '0' } = req.query as Record<string, string>
    const where: any = {}
    if (status) where.status = { in: status.split(',') }
    if (symbol) where.symbol = symbol
    const [data, total] = await Promise.all([
      prisma.breakoutLiveTradeC.findMany({
        where,
        orderBy: { openedAt: 'desc' },
        skip: parseInt(offset, 10) || 0,
        take: Math.min(parseInt(limit, 10) || 100, 500),
      }),
      prisma.breakoutLiveTradeC.count({ where }),
    ])
    // Convert BigInt to string for JSON safety.
    res.json({
      data: data.map((t) => ({
        ...t,
        binanceOrderId: t.binanceOrderId !== null ? String(t.binanceOrderId) : null,
        binanceSlOrderId: t.binanceSlOrderId !== null ? String(t.binanceSlOrderId) : null,
      })),
      total,
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ============================================================================
// Kill switch — cancel all + close all + disable
// ============================================================================

router.post('/kill-switch', async (req, res) => {
  try {
    const { reason } = req.body as { reason?: string }
    const cfg = await prisma.breakoutLiveConfigC.findUnique({ where: { id: 1 } })
    if (!cfg) return res.status(404).json({ error: 'Config not found' })

    const creds = await getBinanceCreds(cfg.useTestnet)
    if (!creds) {
      // Still mark active so the strategy stops trying to open new orders.
      await prisma.breakoutLiveConfigC.update({
        where: { id: 1 },
        data: {
          enabled: false,
          killSwitchActive: true,
          killSwitchReason: reason ?? 'manual (no creds)',
          killSwitchAt: new Date(),
        },
      })
      return res.json({ ok: true, note: 'killed in DB only — Binance creds missing' })
    }

    const client = getBinanceClient(creds)
    await client.syncTime()

    // Cancel all open orders symbol-by-symbol (no global cancel endpoint on USDT-M).
    const openOrders = await client.getOpenOrders()
    const symbolsWithOrders = Array.from(new Set(openOrders.map((o) => o.symbol)))
    let cancelledOrders = 0
    for (const sym of symbolsWithOrders) {
      try {
        await client.cancelAllOpenOrders(sym)
        cancelledOrders += openOrders.filter((o) => o.symbol === sym).length
      } catch (e: any) {
        console.warn(`[BreakoutLiveC kill] cancel ${sym} failed:`, e.message)
      }
    }

    // Close all positions with reduceOnly MARKET.
    const positions = await client.getOpenPositions()
    let closedPositions = 0
    for (const p of positions) {
      const amt = Number(p.positionAmt)
      if (amt === 0) continue
      const side = amt > 0 ? 'SELL' : 'BUY' // close LONG with SELL, SHORT with BUY
      try {
        await client.placeOrder({
          symbol: p.symbol,
          side,
          type: 'MARKET',
          quantity: Math.abs(amt),
          reduceOnly: true,
        })
        closedPositions++
      } catch (e: any) {
        console.warn(`[BreakoutLiveC kill] close ${p.symbol} failed:`, e.message)
      }
    }

    await prisma.breakoutLiveConfigC.update({
      where: { id: 1 },
      data: {
        enabled: false,
        killSwitchActive: true,
        killSwitchReason: reason ?? 'manual',
        killSwitchAt: new Date(),
      },
    })

    res.json({ ok: true, cancelledOrders, closedPositions })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /flatten-all — close all C-LIVE positions only (does NOT disable Strategy).
// Useful for manual mid-day exits without engaging the full kill switch.
router.post('/flatten-all', async (req, res) => {
  try {
    const { reason } = req.body as { reason?: string }
    const r = await flattenAllOpenLiveC(reason ?? 'manual')
    res.json({ ok: true, ...r })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/kill-switch/release', async (_req, res) => {
  try {
    const cfg = await prisma.breakoutLiveConfigC.update({
      where: { id: 1 },
      data: {
        killSwitchActive: false,
        killSwitchReason: null,
        killSwitchAt: null,
      },
    })
    res.json(cfg)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ============================================================================
// Test order placement (TESTNET ONLY) — manual smoke test
// ============================================================================
// POST body: { symbol: 'BTCUSDT', side: 'BUY'|'SELL', priceOffsetPct: 5 }
// Places a LIMIT GTX order priceOffsetPct% away from mark price (won't fill).
// Useful to verify: signing works, leverage/margin type set, order appears in
// Binance UI. Will refuse to run on prod net regardless of API key.

router.post('/test-place-order', async (req, res) => {
  try {
    const { symbol, side, priceOffsetPct = 5, quantity } = req.body as {
      symbol?: string; side?: 'BUY' | 'SELL'; priceOffsetPct?: number; quantity?: number
    }
    if (!symbol || !side) {
      return res.status(400).json({ error: 'symbol and side required' })
    }
    const cfg = await prisma.breakoutLiveConfigC.findUnique({ where: { id: 1 } })
    if (!cfg) return res.status(404).json({ error: 'Config not found' })
    if (!cfg.useTestnet) {
      return res.status(400).json({ error: 'test-place-order is testnet-only. Set useTestnet=true first.' })
    }
    const creds = await getBinanceCreds(true)
    if (!creds) return res.status(400).json({ error: 'Binance testnet ключи не настроены. Добавь их на странице Настройки.' })

    const client = getBinanceClient(creds)
    await client.syncTime()

    const mark = await client.getMarkPrice(symbol)
    // BUY limit BELOW mark (won't fill), SELL limit ABOVE mark.
    const offset = side === 'BUY' ? -1 : 1
    const targetPrice = mark * (1 + (offset * priceOffsetPct) / 100)

    const filters = await client.getSymbolFilters()
    const f = filters.get(symbol)
    if (!f) return res.status(400).json({ error: `Symbol ${symbol} not on Binance Futures` })

    // Round price + qty per filters.
    const tick = f.tickSize
    const step = f.stepSize
    const priceRounded = side === 'BUY'
      ? Math.floor(targetPrice / tick) * tick
      : Math.ceil(targetPrice / tick) * tick
    // Binance Futures wants notional >= 5 (mainnet) or >= 50 (testnet) — the value
    // in exchangeInfo MIN_NOTIONAL filter is the floor but actual enforcement is
    // higher and varies by symbol/network. Use $55 with a fat margin so the test
    // order isn't rejected with -4164 on testnet.
    const minNotional = Math.max(f.minNotional || 5, 55)
    // Use CEIL on the qty calc so the rounded notional stays above the floor —
    // FLOOR could shave the notional just below 55 after step rounding.
    let qty = quantity ?? Math.max(f.minQty, minNotional / priceRounded)
    qty = Math.ceil(qty / step) * step
    qty = Number(qty.toFixed(f.quantityPrecision))

    const cid = `cTEST_${Date.now()}_${side}`
    const order = await client.placeOrder({
      symbol,
      side,
      type: 'LIMIT',
      timeInForce: 'GTC',
      quantity: qty,
      price: Number(priceRounded.toFixed(f.pricePrecision)),
      newClientOrderId: cid,
    })

    res.json({
      ok: true,
      mark,
      placed: {
        orderId: order.orderId,
        clientOrderId: order.clientOrderId,
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        price: Number(order.price),
        origQty: Number(order.origQty),
        status: order.status,
      },
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.delete('/test-orders/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params
    const cfg = await prisma.breakoutLiveConfigC.findUnique({ where: { id: 1 } })
    if (!cfg) return res.status(404).json({ error: 'Config not found' })
    const creds = await getBinanceCreds(cfg.useTestnet)
    if (!creds) return res.status(400).json({ error: 'Binance ключи не настроены. Добавь их на странице Настройки.' })
    const client = getBinanceClient(creds)
    await client.cancelAllOpenOrders(symbol)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

export default router
