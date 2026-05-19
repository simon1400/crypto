/**
 * Live snapshot — WS-driven account state (replaces REST polling from /status).
 *
 * Why: the UI polls /status every 10s for connectivity + balance + positions.
 * Hitting Binance with 3 SIGNED REST calls × 6/min (getAccount + getOpenPositions
 * + getOpenOrders) burned through rate-limit weight and triggered 418/-1003
 * IP bans (2026-05-19). Solution: keep an in-memory snapshot driven by
 * ACCOUNT_UPDATE WS events. REST is only used to seed the snapshot on start
 * and as a stale-data refresh (>= 30s old).
 *
 * ACCOUNT_UPDATE delivers full asset balances and position deltas on every
 * trade event, so the snapshot stays current without polling.
 */

import { prisma } from '../../db/prisma'
import type { BinanceFuturesClient } from '../exchanges/binanceFutures'
import {
  LOG, state, snapshot, lastMarkPriceWs, SNAPSHOT_STALE_MS, LiveSnapshot,
} from './state'

export type { LiveSnapshot } from './state'

export async function getLiveSnapshot(forceRefresh = false): Promise<LiveSnapshot | null> {
  if (!state.current) return null
  const fresh = snapshot.current && Date.now() - snapshot.current.updatedAt <= SNAPSHOT_STALE_MS
  if (forceRefresh || !fresh) {
    try {
      await seedSnapshotFromRest(state.current.client, state.current.net, 'rest-refresh')
    } catch (e: any) {
      console.warn(`${LOG} snapshot refresh failed: ${e.message} — returning stale snapshot`)
    }
  }
  return snapshot.current
}

export async function seedSnapshotFromRest(
  client: BinanceFuturesClient,
  net: 'testnet' | 'prod',
  source: 'rest-seed' | 'rest-refresh',
): Promise<void> {
  // Single getAccount call covers balance + positions. Saves us from the old
  // getAccount + getOpenPositions double-hit. Weight: 5 (vs 5+5 before).
  const acc = await client.getAccount()
  const usdt = acc.assets.find((a) => a.asset === 'USDT')
  // Prefer the account-wide totals — for a USDT-M wallet they equal the USDT
  // asset row, but `totalWalletBalance` / `totalMarginBalance` are the same
  // figures Binance's own UI surfaces (testnet UI labels them "Balance" /
  // "Margin Balance"). Falling back to the asset row keeps a degraded mode
  // alive if Binance ever omits the rolled-up totals.
  const totalFromAccount = Number(acc.totalWalletBalance)
  const totalFromAsset = usdt ? Number(usdt.walletBalance) : 0
  const total = Number.isFinite(totalFromAccount) && totalFromAccount > 0 ? totalFromAccount : totalFromAsset
  const available = Number(acc.availableBalance ?? (usdt?.availableBalance ?? 0))
  // Sanity-check: log any drift between rolled-up totals and the USDT asset
  // row so we have a trail next time the user reports "depo in app ≠ depo on
  // exchange". Most-common cause: a non-USDT margin asset got credited (bonus
  // promo, gift, etc.).
  if (usdt && Math.abs(totalFromAccount - totalFromAsset) > 0.01) {
    console.warn(`${LOG} wallet drift: totalWalletBalance=${totalFromAccount.toFixed(4)} vs assets.USDT.walletBalance=${totalFromAsset.toFixed(4)}`)
  }
  const positions = (acc.positions ?? [])
    .filter((p) => Number(p.positionAmt) !== 0)
    .map((p) => {
      const positionAmt = Number(p.positionAmt)
      const entryPrice = Number(p.entryPrice)
      const markPrice = lastMarkPriceWs.get(p.symbol) ?? Number(p.markPrice ?? p.entryPrice)
      const rawUpnl = Number(p.unRealizedProfit ?? 0)
      // Binance testnet's /fapi/v2/account intermittently returns
      // unRealizedProfit=0 for every position while mark prices are perfectly
      // valid. Don't trust the field if it's literally 0 — recompute from
      // markPrice × positionAmt so /status doesn't flash $0.00 for every P&L
      // cell each REST refresh. Honor Binance's value when non-zero so we
      // don't fight its rounding.
      const unRealizedProfit = rawUpnl !== 0
        ? rawUpnl
        : (markPrice - entryPrice) * positionAmt
      return {
        symbol: p.symbol,
        positionAmt,
        entryPrice,
        markPrice,
        unRealizedProfit,
        leverage: Number(p.leverage ?? 1),
        marginType: (p.marginType === 'isolated' ? 'isolated' : 'cross') as 'isolated' | 'cross',
      }
    })
  snapshot.current = { net, available, total, positions, updatedAt: Date.now(), source }
  // Mirror into BreakoutLiveConfigC.currentDepositUsd so sizing/cycle reads
  // stay in sync with the snapshot — same effect as the old refreshLiveBalance.
  await prisma.breakoutLiveConfigC.update({
    where: { id: 1 },
    data: { currentDepositUsd: available },
  }).catch(() => { /* noop — config row absent at very first boot */ })
}
