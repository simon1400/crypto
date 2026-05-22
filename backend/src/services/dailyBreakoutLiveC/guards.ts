/**
 * Read-only snapshot of every risk guard active in LIVE C.
 *
 * Powers the UI "Гарды" tab — surfaces current value, threshold, status
 * (OK / TRIPPED / NOT_ENFORCED), and distance-to-trip for each guard so the
 * operator can see at a glance which limits are healthy and which are close.
 *
 * No mutations here — this is purely a derivation over BreakoutLiveConfigC,
 * the live wallet snapshot, and today's closed-trades aggregate.
 */

import { prisma } from '../../db/prisma'
import { snapshot, ACTIVE_STATUSES } from './state'
import { isLiveCircuitBreakerTripped } from './breaker'

export type GuardStatus = 'OK' | 'TRIPPED' | 'NOT_ENFORCED' | 'INFO'

export interface GuardRow {
  /** Stable key — used by UI for icons and grouping. */
  key: string
  /** Display name in Russian. */
  label: string
  /** Short description of what this guard does. */
  description: string
  status: GuardStatus
  /** Current measured value (e.g. realizedR today). */
  current: number
  /** Threshold that flips status to TRIPPED. */
  limit: number
  /** Distance from current to limit, signed so + means "still room". */
  remaining: number
  /** Display unit suffix: '%', 'R', '$', 'позиций', etc. */
  unit: string
  /** 0..1 fill ratio for progress bar (1 = at limit). */
  fillRatio: number
  /** When the guard auto-resets (e.g. 'next-utc-day', null = doesn't reset). */
  resetsAt: string | null
  /** Free-form note shown under the row (e.g. "поле есть в БД, гейт не активен"). */
  note?: string
}

export interface GuardsResponse {
  /** ISO time of this read — UI shows "обновлено N сек назад". */
  computedAt: string
  /** UTC date used for daily aggregates. */
  utcDate: string
  /** Wallet metrics used by sizing/margin guards. */
  wallet: {
    total: number
    available: number
    snapshotAge: number | null  // ms since snapshot last refreshed, null if no snapshot
  }
  guards: GuardRow[]
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

export async function getLiveGuards(): Promise<GuardsResponse> {
  const cfg = await prisma.breakoutLiveConfigC.findUnique({ where: { id: 1 } })
  const guards: GuardRow[] = []

  const now = new Date()
  const todayStart = new Date(now)
  todayStart.setUTCHours(0, 0, 0, 0)
  const utcDate = todayStart.toISOString().slice(0, 10)

  const weekStart = new Date(todayStart)
  // Week starts Monday UTC. getUTCDay: 0=Sun..6=Sat → shift to (day-1+7)%7.
  weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7))

  // === Daily aggregates ==================================================
  const closedToday = await prisma.breakoutLiveTradeC.findMany({
    where: {
      closedAt: { gte: todayStart },
      status: { in: ['CLOSED', 'SL_HIT', 'TP3_HIT'] },
    },
    select: { realizedR: true, netPnlUsd: true },
  })
  const dailyR = closedToday.reduce((s, t) => s + (t.realizedR ?? 0), 0)
  const dailyPnl = closedToday.reduce((s, t) => s + (t.netPnlUsd ?? 0), 0)

  // Weekly aggregate — net PnL since Monday 00:00 UTC.
  const closedThisWeek = await prisma.breakoutLiveTradeC.findMany({
    where: {
      closedAt: { gte: weekStart },
      status: { in: ['CLOSED', 'SL_HIT', 'TP3_HIT'] },
    },
    select: { netPnlUsd: true },
  })
  const weeklyPnl = closedThisWeek.reduce((s, t) => s + (t.netPnlUsd ?? 0), 0)

  const walletTotal = snapshot.current?.total ?? cfg?.currentDepositUsd ?? 0
  const walletAvailable = snapshot.current?.available ?? cfg?.currentDepositUsd ?? 0
  const snapshotAge = snapshot.current ? Date.now() - snapshot.current.updatedAt : null

  // Re-use the real breaker so guard numbers match what placement.ts sees.
  // breaker.ts reconstructs startOfDayDeposit from cfg.currentDepositUsd (which
  // mirrors Binance availableBalance, not walletTotal) — using a different
  // formula here showed −9% while the breaker had already tripped at −18%.
  const breakerResult = cfg
    ? await isLiveCircuitBreakerTripped(cfg)
    : { tripped: false, reason: '', realizedR: dailyR, netPnlUsd: dailyPnl, pnlPct: 0 }
  const dailyPnlPct = breakerResult.pnlPct

  // Weekly start-of-week reconstruction kept local — no enforcement path uses it.
  const sowDeposit = Math.max(1, walletTotal - weeklyPnl)
  const weeklyPnlPct = (weeklyPnl / sowDeposit) * 100

  // === 1. Daily loss limit (R) ===========================================
  // Mirrors breaker.ts: trips when sum(realizedR) <= -limit.
  {
    const limit = Math.abs(cfg?.dailyLossLimitR ?? 8)
    const rTripped = breakerResult.realizedR <= -limit
    const remaining = limit + breakerResult.realizedR
    guards.push({
      key: 'daily_loss_r',
      label: 'Дневной лимит (R)',
      description: 'Σ realizedR закрытых сегодня UTC. Превышение → блок новых лимиток + отмена PENDING.',
      status: rTripped ? 'TRIPPED' : 'OK',
      current: breakerResult.realizedR,
      limit: -limit,
      remaining,
      unit: 'R',
      fillRatio: clamp(-breakerResult.realizedR / limit, 0, 1),
      resetsAt: 'next-utc-day',
    })
  }

  // === 2. Daily loss limit (%) ===========================================
  // Use breakerResult.pnlPct so the displayed % matches what the breaker gate
  // actually compares against. The `reason` string from breaker is shown as a
  // note so the user sees which leg of the OR-condition tripped.
  {
    const limit = Math.abs(cfg?.dailyLossLimitPct ?? 10)
    const pctTripped = dailyPnlPct <= -limit
    const remaining = limit + dailyPnlPct
    guards.push({
      key: 'daily_loss_pct',
      label: 'Дневной лимит (%)',
      description: 'Σ netPnlUsd сегодня / SOD-wallet (вчерашний EOD-snapshot). Если breaker сработал, при возврате pnl выше лимита он автоматически снимется на след. placement-цикле.',
      status: pctTripped ? 'TRIPPED' : 'OK',
      current: dailyPnlPct,
      limit: -limit,
      remaining,
      unit: '%',
      fillRatio: clamp(-dailyPnlPct / limit, 0, 1),
      resetsAt: 'next-utc-day',
      note: breakerResult.tripped ? `Breaker сейчас активен: ${breakerResult.reason}` : undefined,
    })
  }

  // === 3. Weekly loss limit (%) — поле есть, гейт не реализован ==========
  {
    const limit = Math.abs(cfg?.weeklyLossLimitPct ?? 15)
    const remaining = limit + weeklyPnlPct
    guards.push({
      key: 'weekly_loss_pct',
      label: 'Недельный лимит (%)',
      description: 'Σ netPnlUsd с понедельника / start-of-week deposit. Только мониторинг — гейт не активен.',
      status: 'NOT_ENFORCED',
      current: weeklyPnlPct,
      limit: -limit,
      remaining,
      unit: '%',
      fillRatio: clamp(-weeklyPnlPct / limit, 0, 1),
      resetsAt: 'next-monday-utc',
      note: 'Поле в БД присутствует, но enforcement в коде не реализован',
    })
  }

  // === 4. Margin cap (90% wallet) ========================================
  const openPositions = (snapshot.current?.positions ?? []).filter((p) => Math.abs(p.positionAmt) > 0)
  const lockedMargin = openPositions.reduce((s, p) => {
    // Approximation: notional / leverage. Snapshot has leverage per-position.
    const notional = Math.abs(p.positionAmt) * (p.markPrice || p.entryPrice)
    return s + (p.leverage ? notional / p.leverage : 0)
  }, 0)
  {
    const cap = walletTotal * 0.9
    const tripped = lockedMargin >= cap
    const remaining = cap - lockedMargin
    guards.push({
      key: 'margin_cap_90pct',
      label: 'Margin cap (90% wallet)',
      description: 'locked margin + new entry margin ≤ 90% × walletBalance. Превышение → rollback в PENDING.',
      status: tripped ? 'TRIPPED' : 'OK',
      current: lockedMargin,
      limit: cap,
      remaining,
      unit: '$',
      fillRatio: walletTotal > 0 ? clamp(lockedMargin / cap, 0, 1) : 0,
      resetsAt: null,
    })
  }

  // === 5. Max concurrent positions =======================================
  const openCount = await prisma.breakoutLiveTradeC.count({
    where: { status: { in: [...ACTIVE_STATUSES] } },
  })
  {
    const limit = cfg?.maxConcurrentPositions ?? 20
    const tripped = openCount >= limit
    guards.push({
      key: 'max_concurrent',
      label: 'Max concurrent positions',
      description: 'Лимит одновременно открытых OPEN/TP1_HIT/TP2_HIT. Превышение в tryFillVirtualLimit → rollback.',
      status: tripped ? 'TRIPPED' : 'OK',
      current: openCount,
      limit,
      remaining: limit - openCount,
      unit: 'поз.',
      fillRatio: limit > 0 ? clamp(openCount / limit, 0, 1) : 0,
      resetsAt: null,
    })
  }

  // === 6. Max positions per symbol =======================================
  {
    const limit = cfg?.maxPositionsPerSymbol ?? 1
    // Group active trades by symbol and report the max-bucket.
    const activeBySymbol = await prisma.breakoutLiveTradeC.groupBy({
      by: ['symbol'],
      where: { status: { in: [...ACTIVE_STATUSES] } },
      _count: { _all: true },
    })
    const maxBucket = activeBySymbol.reduce((m, r) => Math.max(m, r._count._all), 0)
    const tripped = maxBucket >= limit
    guards.push({
      key: 'max_per_symbol',
      label: 'Позиций на символ',
      description: 'Лимит активных позиций на один символ.',
      status: tripped ? 'TRIPPED' : 'OK',
      current: maxBucket,
      limit,
      remaining: limit - maxBucket,
      unit: 'поз.',
      fillRatio: limit > 0 ? clamp(maxBucket / limit, 0, 1) : 0,
      resetsAt: null,
    })
  }

  // === 7. Risk per trade — info, not a threshold =========================
  {
    const pct = cfg?.riskPctPerTrade ?? 2
    const riskUsd = walletTotal * (pct / 100)
    guards.push({
      key: 'risk_per_trade',
      label: 'Риск на сделку',
      description: 'Доля депозита, рискуемая на одной сделке. Считается от walletTotal.',
      status: 'INFO',
      current: pct,
      limit: pct,
      remaining: riskUsd,  // re-used to show $-equivalent in UI
      unit: '%',
      fillRatio: 0,
      resetsAt: null,
      note: `≈ ${riskUsd.toFixed(2)}$ на сделку при текущем walletTotal ${walletTotal.toFixed(2)}$`,
    })
  }

  // === 8. EOD-FLAT timer =================================================
  {
    // 23:55 UTC — flatten + cancel-all-pending.
    const eodToday = new Date(now)
    eodToday.setUTCHours(23, 55, 0, 0)
    let remainingMs = eodToday.getTime() - now.getTime()
    if (remainingMs < 0) remainingMs += 24 * 60 * 60 * 1000
    const remainingHours = remainingMs / (60 * 60 * 1000)
    guards.push({
      key: 'eod_flush',
      label: 'EOD-FLAT таймер',
      description: 'В 23:55 UTC закрываются все позиции по рынку + отменяются висящие лимитки.',
      status: 'INFO',
      current: remainingHours,
      limit: 0,
      remaining: remainingHours,
      unit: 'ч',
      fillRatio: 1 - remainingHours / 24,
      resetsAt: 'next-utc-day',
    })
  }

  return {
    computedAt: now.toISOString(),
    utcDate,
    wallet: {
      total: walletTotal,
      available: walletAvailable,
      snapshotAge,
    },
    guards,
  }
}