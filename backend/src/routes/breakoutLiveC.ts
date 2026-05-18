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
    const cfg = await prisma.breakoutLiveConfigC.update({
      where: { id: 1 },
      data: {
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
    const [balance, positions, openOrders] = await Promise.all([
      client.getBalanceUsdt(),
      client.getOpenPositions(),
      client.getOpenOrders(),
    ])

    res.json({
      connected: true,
      net: creds.net,
      enabled: cfg.enabled,
      killSwitchActive: cfg.killSwitchActive,
      killSwitchReason: cfg.killSwitchReason,
      balanceUsdt: balance,
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
    const minNotional = f.minNotional || 5
    let qty = quantity ?? Math.max(f.minQty, (minNotional * 1.1) / priceRounded)
    qty = Math.floor(qty / step) * step
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
