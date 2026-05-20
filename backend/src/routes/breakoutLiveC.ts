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
import { buildSharedReadHandlers } from './breakoutPaper/index'
import { flattenAllOpenLiveC, flattenOneOpenLiveC, getLiveSnapshot, attachMissingSlTp } from '../services/dailyBreakoutLiveC'

// Re-export so existing import paths (`from './breakoutLiveC'`) keep working.
export { refreshLiveBalance }

const router = Router()

// Cache for /fapi/v1/openAlgoOrders. SIGNED REST, weight 5+. /status is
// polled every 10s and shared across tabs/users — refreshing on every call
// would burn ~30 weight/min just for a tab that's mostly closed. TTL=5min
// means at worst 1 refresh per /status poll cycle = ≤2 calls/10min = 10
// weight/10min, while still showing fresh-enough data when the user actually
// opens the "Биржа" tab (algo orders don't churn that fast — TP/SL stays put
// until exit).
interface AlgoOrderRow {
  algoId: number
  clientAlgoId: string
  symbol: string
  side: 'BUY' | 'SELL'
  /** Canonical: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET'. Derived from
   *  clientAlgoId (slL{id} / tpL{id}_{idx}) since Binance's raw `type` field
   *  is inconsistent across endpoint versions. */
  type: string
  /** 1, 2 or 3 — only set for TAKE_PROFIT_MARKET. */
  tpIdx: number | null
  triggerPrice: number
  quantity: number
  reduceOnly: boolean
  createdAt: number | null
}
const algoOrdersCache: { at: number; data: AlgoOrderRow[] } = { at: 0, data: [] }
const ALGO_ORDERS_TTL_MS = 5 * 60 * 1000   // 5 min — see /status doc-note


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
    // current Binance wallet balance (total realized PnL incl. unspent margin)
    // as startingDepositUsd. This becomes the reference point for Total P&L
    // going forward — "Total PnL" displayed in UI is walletBalance - baseline.
    // Use totalWalletBalance, NOT availableBalance: available shrinks every
    // time we open a position (margin gets locked), which would make baseline
    // depend on how many trades happen to be live at the snapshot moment.
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
            const totalFromAccount = Number(acc.totalWalletBalance)
            const totalFromAsset = usdt ? Number(usdt.walletBalance) : 0
            const wallet = Number.isFinite(totalFromAccount) && totalFromAccount > 0 ? totalFromAccount : totalFromAsset
            if (wallet > 0) {
              baselineSnapshot = {
                startingDepositUsd: wallet,
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
    const totalFromAccount = Number(acc.totalWalletBalance)
    const totalFromAsset = usdt ? Number(usdt.walletBalance) : 0
    const wallet = Number.isFinite(totalFromAccount) && totalFromAccount > 0 ? totalFromAccount : totalFromAsset
    if (wallet <= 0) return res.status(400).json({ error: 'На Binance нулевой wallet баланс USDT' })

    const updated = await prisma.breakoutLiveConfigC.update({
      where: { id: 1 },
      data: {
        startingDepositUsd: wallet,
        currentDepositUsd: wallet,
        peakDepositUsd: wallet,
        maxDrawdownPct: 0,
        resetAt: new Date(),
      },
    })
    res.json({ ok: true, baselineUsd: wallet, config: updated })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ============================================================================
// Status — connectivity smoke test
// ============================================================================

router.get('/status', async (req, res) => {
  try {
    // ?refresh=1 force-busts the algoOrders cache. Used by the "Биржа" tab's
    // manual refresh button — fine, weight 5 per click, no spam vector.
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true'
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

    // WS-driven snapshot — no REST call here in the hot path. getLiveSnapshot()
    // refreshes itself via REST only when older than 5 min. UI polls /status
    // every 10s — at 6 polls/min that's zero exchange traffic 99% of the time.
    // (Was burning 50+ weight/min on the old getAccount/getOpenPositions/
    //  getOpenOrders trio, triggering 418/-1003 IP bans.)
    const snap = await getLiveSnapshot()
    if (!snap) {
      // Trader not running (WS not connected) — return safe defaults.
      return res.json({
        connected: false,
        net: creds.net,
        reason: 'Live trader is not running. Check backend logs.',
        enabled: cfg.enabled,
        killSwitchActive: cfg.killSwitchActive,
        killSwitchReason: cfg.killSwitchReason,
      })
    }

    const baseline = cfg.startingDepositUsd
    const unrealizedPnl = snap.positions.reduce((a, p) => a + (p.unRealizedProfit ?? 0), 0)
    const marginBalance = snap.total + unrealizedPnl
    // "Доходность" / "Total P&L" — только реализованный итог. walletBalance
    // вбирает в себя realized PnL (Binance прибавляет его к кошельку при
    // close) минус комиссии минус funding. Сравнение с baseline (snapshot
    // wallet'а при первом /config enable) даёт чистый доход от закрытых
    // сделок. Плавающий P&L открытых видно отдельным блоком "Депо с открытыми".
    const totalPnlUsd = snap.total - baseline
    const totalPnlPct = baseline > 0 ? (totalPnlUsd / baseline) * 100 : 0

    // Pending limits live in DB (virtual limits), not on the exchange.
    // Header counts the SAME unit the UI "Pending" tab renders — one row per
    // symbol (BUY/SELL pair collapsed). Counting raw rows confused users
    // (e.g. "5 ордеров" but only 2 pairs visible). distinct symbol count is
    // what they see in the table.
    const pendingRows = await prisma.breakoutLiveTradeC.findMany({
      where: { status: 'PENDING_LIMIT' },
      select: { symbol: true },
    })
    const pendingOrders = new Set(pendingRows.map((r) => r.symbol)).size

    // Conditional TP/SL list — refreshed at most once per ALGO_ORDERS_TTL_MS.
    // If the refresh fails (rate-limit, network) we still serve the previous
    // snapshot so the UI doesn't flicker to empty between polls.
    const now = Date.now()
    if (forceRefresh || now - algoOrdersCache.at >= ALGO_ORDERS_TTL_MS) {
      try {
        const client = getBinanceClient(creds)
        if (client) {
          const raw = await client.getOpenAlgoOrders()
          if (raw.length > 0) {
            // Once-per-refresh sample so we can see what Binance actually
            // returns (field naming differs across endpoint versions: type vs
            // algoType, triggerPrice vs stopPrice, etc.).
            console.log('[breakoutLiveC] /status algoOrders sample:', JSON.stringify(raw[0]))
          }
          algoOrdersCache.data = raw.map((o) => {
            const anyO = o as any
            const qtyStr = o.quantity ?? o.origQty ?? '0'
            // Source of truth: our own clientAlgoId. Format set by the trader:
            //   'slL{tradeId}'           — STOP_MARKET (SL)
            //   'tpL{tradeId}_{idx}'     — TAKE_PROFIT_MARKET, idx ∈ {1,2,3}
            // The raw `type`/`algoType` fields are kept as a fallback for any
            // orphan ordered outside the bot (rare, e.g. manual UI placement).
            const cid = String(o.clientAlgoId ?? '')
            let canonicalType = ''
            let tpIdx: number | null = null
            if (cid.startsWith('slL')) {
              canonicalType = 'STOP_MARKET'
            } else {
              const m = cid.match(/^tpL\d+_(\d+)$/)
              if (m) {
                canonicalType = 'TAKE_PROFIT_MARKET'
                tpIdx = Number(m[1])
              } else {
                const rawType = String(o.type ?? anyO.algoType ?? '').toUpperCase()
                if (rawType.includes('STOP') && !rawType.includes('TAKE')) canonicalType = 'STOP_MARKET'
                else if (rawType.includes('TAKE_PROFIT') || rawType.includes('PROFIT')) canonicalType = 'TAKE_PROFIT_MARKET'
              }
            }
            return {
              algoId: o.algoId,
              clientAlgoId: o.clientAlgoId,
              symbol: o.symbol,
              side: o.side,
              type: canonicalType,
              tpIdx,
              triggerPrice: Number(o.triggerPrice ?? anyO.stopPrice ?? 0),
              quantity: Number(qtyStr),
              reduceOnly: o.reduceOnly,
              createdAt: Number(anyO.bookTime ?? anyO.createTime ?? anyO.updateTime ?? 0) || null,
            }
          })
          algoOrdersCache.at = now
        }
      } catch (e: any) {
        console.warn('[breakoutLiveC] /status algoOrders fetch failed:', e.message)
      }
    }

    res.json({
      connected: true,
      net: creds.net,
      enabled: cfg.enabled,
      killSwitchActive: cfg.killSwitchActive,
      killSwitchReason: cfg.killSwitchReason,
      balanceUsdt: snap.available,
      walletBalanceUsdt: snap.total,
      marginBalanceUsdt: marginBalance,
      unrealizedPnlUsdt: unrealizedPnl,
      baselineUsd: baseline,
      totalPnlUsd: Math.round(totalPnlUsd * 100) / 100,
      totalPnlPct: Math.round(totalPnlPct * 100) / 100,
      baselineSnapshottedAt: cfg.resetAt,
      openPositions: snap.positions.length,
      openOrders: pendingOrders,
      snapshotAge: Date.now() - snap.updatedAt,
      snapshotSource: snap.source,
      positions: snap.positions.map((p) => ({
        symbol: p.symbol,
        positionAmt: p.positionAmt,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice,
        unRealizedProfit: p.unRealizedProfit,
        leverage: p.leverage,
        marginType: p.marginType,
      })),
      algoOrders: algoOrdersCache.data,
      algoOrdersAge: now - algoOrdersCache.at,
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
// Wipe-all — DANGEROUS: deletes BreakoutLiveTradeC rows + resets config stats.
//
// Does NOT touch the exchange itself — caller must have already flattened
// positions via kill-switch or /flatten-all. Used after a misconfiguration
// run to start fresh from a clean DB. Will refuse to run on prod net unless
// confirmation=PROD_WIPE_ACK is passed in the body.
// ============================================================================

router.post('/wipe-all', async (req, res) => {
  try {
    const { confirmation } = req.body as { confirmation?: string }
    const cfg = await prisma.breakoutLiveConfigC.findUnique({ where: { id: 1 } })
    if (!cfg) return res.status(404).json({ error: 'Config not found' })

    if (!cfg.useTestnet && confirmation !== 'PROD_WIPE_ACK') {
      return res.status(400).json({
        error: 'Wipe on PROD network requires confirmation=PROD_WIPE_ACK in body. Caller should pop a hard "type PROD_WIPE_ACK" prompt before sending.',
      })
    }

    // Refuse if anything still open on exchange — would orphan a position
    // with no DB trace.
    const creds = await getBinanceCreds(cfg.useTestnet)
    if (creds) {
      const client = getBinanceClient(creds)
      const positions = await client.getOpenPositions().catch(() => null)
      if (positions && positions.length > 0) {
        return res.status(400).json({
          error: `Cannot wipe: ${positions.length} position(s) still open on Binance. Use kill-switch or /flatten-all first.`,
        })
      }
    }

    const deletedTrades = await prisma.breakoutLiveTradeC.deleteMany({})
    const deletedFunding = await prisma.breakoutLiveFundingC.deleteMany({})
    const deletedAttempts = await prisma.breakoutLiveAttemptC.deleteMany({})
    const reset = await prisma.breakoutLiveConfigC.update({
      where: { id: 1 },
      data: {
        enabled: false,
        killSwitchActive: false,
        killSwitchReason: null,
        killSwitchAt: null,
        resetAt: null,
        startingDepositUsd: 100,
        currentDepositUsd: 100,
        peakDepositUsd: 100,
        maxDrawdownPct: 0,
        totalTrades: 0,
        totalWins: 0,
        totalLosses: 0,
        totalPnLUsd: 0,
        totalFundingUsd: 0,
      },
    })
    res.json({
      ok: true,
      deletedTrades: deletedTrades.count,
      deletedFunding: deletedFunding.count,
      deletedAttempts: deletedAttempts.count,
      config: reset,
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ============================================================================
// Switch network — testnet ↔ real. Atomic operation:
//   1. Refuse if strategy enabled or kill-switch active (caller must disable first)
//   2. Refuse if open positions on EITHER net (would orphan exchange state)
//   3. For testnet → real: require body { confirmation: 'SWITCH_TO_REAL_ACK' }
//      + verify live keys are configured
//   4. Wipe all DB rows (BreakoutLiveTradeC/Funding/AttemptC) — statistics reset
//   5. Set useTestnet flag, clear resetAt → next enable snapshots baseline
//      from the NEW net's walletBalance automatically
//   6. Leave enabled=false — user must press Запустить manually after reviewing
//      balance / positions on the new net
// ============================================================================

router.post('/switch-network', async (req, res) => {
  try {
    const { target, confirmation } = req.body as {
      target?: 'testnet' | 'real'
      confirmation?: string
    }
    if (target !== 'testnet' && target !== 'real') {
      return res.status(400).json({ error: 'target must be "testnet" or "real"' })
    }

    const cfg = await prisma.breakoutLiveConfigC.findUnique({ where: { id: 1 } })
    if (!cfg) return res.status(404).json({ error: 'Config not found' })

    const targetTestnet = target === 'testnet'
    if (cfg.useTestnet === targetTestnet) {
      return res.status(400).json({ error: `Already on ${target}` })
    }

    // Hard guard: strategy must be off
    if (cfg.enabled) {
      return res.status(400).json({
        error: 'Strategy is still running. Disable it first (press Остановить).',
      })
    }

    // Switching to real demands an explicit confirmation token from the client.
    // testnet → real is the dangerous direction; reverse is allowed without it.
    if (target === 'real' && confirmation !== 'SWITCH_TO_REAL_ACK') {
      return res.status(400).json({
        error: 'Switching to real requires confirmation=SWITCH_TO_REAL_ACK in body.',
      })
    }

    // Verify live keys are configured before flipping the flag — otherwise the
    // next /status / enable would just error out and the UI would be confusing.
    if (target === 'real') {
      const liveCreds = await getBinanceCreds(false)
      if (!liveCreds) {
        return res.status(400).json({
          error: 'Live ключи Binance не настроены. Добавь их в Настройках перед переключением.',
        })
      }
    }

    // Check open positions on BOTH nets — we're wiping DB and we don't want to
    // lose track of an exchange-side position on either side.
    for (const net of ['testnet', 'real'] as const) {
      const creds = await getBinanceCreds(net === 'testnet')
      if (!creds) continue
      try {
        const client = getBinanceClient(creds)
        const positions = await client.getOpenPositions().catch(() => null)
        if (positions && positions.length > 0) {
          return res.status(400).json({
            error: `Cannot switch: ${positions.length} position(s) still open on Binance ${net}. Close them first.`,
          })
        }
      } catch {
        // If we can't reach one of the nets we still allow the switch — the
        // wipe is DB-only, and the next /status call will surface any issue.
      }
    }

    const deletedTrades = await prisma.breakoutLiveTradeC.deleteMany({})
    const deletedFunding = await prisma.breakoutLiveFundingC.deleteMany({})
    const deletedAttempts = await prisma.breakoutLiveAttemptC.deleteMany({})
    const reset = await prisma.breakoutLiveConfigC.update({
      where: { id: 1 },
      data: {
        useTestnet: targetTestnet,
        enabled: false,
        killSwitchActive: false,
        killSwitchReason: null,
        killSwitchAt: null,
        // Clear baseline state — next enable will re-snapshot from walletBalance
        // of the freshly-selected net.
        resetAt: null,
        startingDepositUsd: 100,
        currentDepositUsd: 100,
        peakDepositUsd: 100,
        maxDrawdownPct: 0,
        totalTrades: 0,
        totalWins: 0,
        totalLosses: 0,
        totalPnLUsd: 0,
        totalFundingUsd: 0,
      },
    })

    res.json({
      ok: true,
      target,
      deletedTrades: deletedTrades.count,
      deletedFunding: deletedFunding.count,
      deletedAttempts: deletedAttempts.count,
      config: reset,
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /reset — alias of /baseline/reset that the BreakoutPaper UI expects.
// Body: { startingDepositUsd? } is IGNORED for live (baseline always comes
// from Binance walletBalance). Kept for API surface compatibility.
router.post('/reset', async (_req, res) => {
  try {
    const cfg = await prisma.breakoutLiveConfigC.findUnique({ where: { id: 1 } })
    if (!cfg) return res.status(404).json({ error: 'Config not found' })

    const creds = await getBinanceCreds(cfg.useTestnet)
    if (!creds) return res.status(400).json({ error: 'Binance keys not configured.' })

    const client = getBinanceClient(creds)
    await client.syncTime()
    const acc = await client.getAccount()
    const usdt = acc.assets.find((a) => a.asset === 'USDT')
    const totalFromAccount = Number(acc.totalWalletBalance)
    const totalFromAsset = usdt ? Number(usdt.walletBalance) : 0
    const wallet = Number.isFinite(totalFromAccount) && totalFromAccount > 0 ? totalFromAccount : totalFromAsset
    if (wallet <= 0) return res.status(400).json({ error: 'Zero USDT wallet balance on Binance.' })

    const updated = await prisma.breakoutLiveConfigC.update({
      where: { id: 1 },
      data: {
        startingDepositUsd: wallet,
        currentDepositUsd: wallet,
        peakDepositUsd: wallet,
        maxDrawdownPct: 0,
        resetAt: new Date(),
      },
    })
    res.json(updated)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ============================================================================
// Trades
// ============================================================================

// Shared read handlers (identical shape to paper /trades/live and /stats so
// the BreakoutPaper component can render either off the same response).
const sharedRead = buildSharedReadHandlers('LIVE')
router.get('/trades/live', sharedRead.tradesLive)
router.get('/stats', sharedRead.stats)

router.get('/trades', async (req, res) => {
  try {
    const { status, symbol, limit = '100', offset = '0', orderBy } = req.query as Record<string, string>
    const where: any = {}
    if (status) where.status = { in: status.split(',') }
    if (symbol) where.symbol = symbol
    // Mirror paper trader: orderBy=closedAt switches sort key for the "Закрытые" tab.
    const orderField: 'openedAt' | 'closedAt' = orderBy === 'closedAt' ? 'closedAt' : 'openedAt'
    const [data, total] = await Promise.all([
      prisma.breakoutLiveTradeC.findMany({
        where,
        orderBy: { [orderField]: 'desc' },
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

// GET /trades/:id — single row, used by the BreakoutPaperTradeModal when the UI
// runs in variant=LIVE mode.
router.get('/trades/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' })
    const t = await prisma.breakoutLiveTradeC.findUnique({ where: { id } })
    if (!t) return res.status(404).json({ error: 'Trade not found' })
    res.json({
      ...t,
      binanceOrderId: t.binanceOrderId !== null ? String(t.binanceOrderId) : null,
      binanceSlOrderId: t.binanceSlOrderId !== null ? String(t.binanceSlOrderId) : null,
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /trades/close-all-market — close every OPEN/TP1_HIT/TP2_HIT LIVE-C position
// via reduceOnly MARKET. Thin wrapper over flattenAllOpenLiveC so the BreakoutPaper
// UI's "Закрыть все по рынку" button works in LIVE mode.
router.post('/trades/close-all-market', async (_req, res) => {
  try {
    const r = await flattenAllOpenLiveC('manual')
    res.json({ closed: r.closed, failed: r.failed, ids: [] })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /trades/:id/close-market — close one LIVE-C position via reduceOnly MARKET.
// Returns the updated DB row so the UI can refresh.
router.post('/trades/:id/close-market', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' })
    const r = await flattenOneOpenLiveC(id, 'manual')
    if (!r.ok) return res.status(400).json({ error: r.error })
    const t = await prisma.breakoutLiveTradeC.findUnique({ where: { id } })
    if (!t) return res.status(404).json({ error: 'Trade not found after close' })
    res.json({
      ...t,
      binanceOrderId: t.binanceOrderId !== null ? String(t.binanceOrderId) : null,
      binanceSlOrderId: t.binanceSlOrderId !== null ? String(t.binanceSlOrderId) : null,
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// GET /attempts — placement attempts audit log. Powers the LIVE 'Отклонённые'
// tab. Default returns today's UTC bucket; ?rangeDate=YYYY-MM-DD overrides.
// Each row: PLACED | REJECTED_EXCHANGE | SKIPPED_GATE | SKIPPED_FILTER + the
// price context at attempt time.
router.get('/attempts', async (req, res) => {
  try {
    const todayUtc = new Date().toISOString().slice(0, 10)
    const rangeDate = typeof req.query.rangeDate === 'string' && req.query.rangeDate
      ? req.query.rangeDate
      : todayUtc
    const limit = Math.min(parseInt(String(req.query.limit ?? '500'), 10) || 500, 2000)

    // Real totals come from groupBy + count — not from rows.length, which only
    // reflects the limited window we return for the table.
    const [rows, statusGroups, totalCount] = await Promise.all([
      prisma.breakoutLiveAttemptC.findMany({
        where: { rangeDate },
        orderBy: { attemptedAt: 'desc' },
        take: limit,
      }),
      prisma.breakoutLiveAttemptC.groupBy({
        by: ['status'],
        where: { rangeDate },
        _count: { _all: true },
      }),
      prisma.breakoutLiveAttemptC.count({ where: { rangeDate } }),
    ])

    // statusGroups is an array of { status, _count: { _all: N } }. Flatten.
    const counts: Record<string, number> = {}
    for (const g of statusGroups) counts[g.status] = (g._count?._all ?? 0)

    res.json({
      data: rows,
      rangeDate,
      shown: rows.length,
      total: totalCount,
      counts: {
        placed:    counts['PLACED']            ?? 0,
        rejected:  counts['REJECTED_EXCHANGE'] ?? 0,
        gated:     counts['SKIPPED_GATE']      ?? 0,
        filtered:  counts['SKIPPED_FILTER']    ?? 0,
      },
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// DELETE /attempts — clear today's attempt log. The UI button.
router.delete('/attempts', async (req, res) => {
  try {
    const todayUtc = new Date().toISOString().slice(0, 10)
    const rangeDate = typeof req.query.rangeDate === 'string' && req.query.rangeDate
      ? req.query.rangeDate
      : todayUtc
    const r = await prisma.breakoutLiveAttemptC.deleteMany({ where: { rangeDate } })
    res.json({ deleted: r.count, rangeDate })
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

// POST /repair-sltp — backfill missing exchange-side SL / TP algo orders on
// already-open positions. Idempotent: re-running it after everything is in
// place is a no-op. Used when hybrid TP shipped after some positions were
// already open via the pre-hybrid code path (those had SL but no TPs), or
// when a Binance algo order was cancelled out-of-band.
router.post('/trades/repair-sltp', async (_req, res) => {
  try {
    const report = await attachMissingSlTp()
    res.json(report)
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
