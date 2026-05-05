/**
 * Levels Daily Summary — посылает раз в день (23:55 UTC) сводку всех Levels-сделок дня.
 *
 * Что входит:
 *   - Сколько новых сигналов открыто за день
 *   - Сколько закрыто (TP3/SL/EXPIRED)
 *   - Wins / Losses
 *   - Total R за день
 *   - Net USD P&L (если paper включён)
 *   - Депозит на начало/конец дня
 *   - Per-symbol breakdown
 *
 * Привязан к UTC чтобы не зависеть от TZ сервера.
 */

import { prisma } from '../db/prisma'
import { sendNotification } from './notifier'

const SUMMARY_HOUR_UTC = 23
const SUMMARY_MIN_UTC = 55

let summaryInterval: NodeJS.Timeout | null = null
let lastSummaryDate: string | null = null

function todayUtcKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function startOfDayUtc(d: Date): Date {
  const x = new Date(d)
  x.setUTCHours(0, 0, 0, 0)
  return x
}

export async function buildDailySummary(forDate?: Date): Promise<{
  date: string
  opened: number
  closed: number
  wins: number
  losses: number
  totalR: number
  totalUsd?: number
  startUsd?: number
  endUsd?: number
  peakUsd?: number
  bySymbol: Array<{ symbol: string; pnlR: number; pnlUsd: number; trades: number }>
}> {
  const date = forDate ?? new Date()
  const startOfDay = startOfDayUtc(date)
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60_000)

  // Live signals opened today
  const openedSignals = await prisma.levelsSignal.findMany({
    where: { createdAt: { gte: startOfDay, lt: endOfDay } },
    select: { id: true, symbol: true },
  })
  const opened = openedSignals.length

  // Closed today (status final)
  const closedSignals = await prisma.levelsSignal.findMany({
    where: {
      closedAt: { gte: startOfDay, lt: endOfDay },
      status: { in: ['CLOSED', 'SL_HIT', 'EXPIRED'] },
    },
    select: { id: true, symbol: true, realizedR: true },
  })
  const closed = closedSignals.length
  const wins = closedSignals.filter((s) => s.realizedR > 0).length
  const losses = closedSignals.filter((s) => s.realizedR < 0).length
  const totalR = closedSignals.reduce((a, s) => a + s.realizedR, 0)

  // Per-symbol breakdown by R
  const symMap = new Map<string, { pnlR: number; pnlUsd: number; trades: number }>()
  for (const s of closedSignals) {
    const m = symMap.get(s.symbol) ?? { pnlR: 0, pnlUsd: 0, trades: 0 }
    m.pnlR += s.realizedR
    m.trades++
    symMap.set(s.symbol, m)
  }

  // Try to enrich with USD from paper trades
  let totalUsd: number | undefined
  let startUsd: number | undefined
  let endUsd: number | undefined
  let peakUsd: number | undefined
  try {
    const paperCfg = await prisma.levelsPaperConfig.findUnique({ where: { id: 1 } })
    if (paperCfg) {
      const closedPaper = await prisma.levelsPaperTrade.findMany({
        where: { closedAt: { gte: startOfDay, lt: endOfDay } },
        select: { symbol: true, netPnlUsd: true },
      })
      totalUsd = closedPaper.reduce((a, t) => a + t.netPnlUsd, 0)
      endUsd = paperCfg.currentDepositUsd
      startUsd = endUsd - totalUsd
      peakUsd = paperCfg.peakDepositUsd
      // Add per-symbol USD
      for (const t of closedPaper) {
        const m = symMap.get(t.symbol)
        if (m) m.pnlUsd += t.netPnlUsd
      }
    }
  } catch {
    // Paper config might not exist yet — skip USD enrichment
  }

  const bySymbol = [...symMap.entries()]
    .map(([symbol, v]) => ({ symbol, ...v }))
    .sort((a, b) => Math.abs(b.pnlR) - Math.abs(a.pnlR))

  return {
    date: startOfDay.toISOString().slice(0, 10),
    opened, closed, wins, losses, totalR,
    totalUsd, startUsd, endUsd, peakUsd,
    bySymbol,
  }
}

export async function sendDailySummary(): Promise<void> {
  const summary = await buildDailySummary()
  // Skip empty days
  if (summary.opened === 0 && summary.closed === 0) return
  await sendNotification('LEVELS_DAILY_SUMMARY' as any, summary)
}

export function startLevelsDailySummary(): void {
  if (summaryInterval) return
  // Check every minute — fire when UTC time is HH:MM matching SUMMARY_HOUR_UTC:SUMMARY_MIN_UTC
  const tick = async () => {
    try {
      const now = new Date()
      const hr = now.getUTCHours()
      const min = now.getUTCMinutes()
      const today = todayUtcKey()
      if (hr === SUMMARY_HOUR_UTC && min === SUMMARY_MIN_UTC && lastSummaryDate !== today) {
        lastSummaryDate = today
        await sendDailySummary()
        console.log('[DailySummary] sent for', today)
      }
    } catch (e: any) {
      console.error('[DailySummary] tick error:', e.message)
    }
  }
  summaryInterval = setInterval(tick, 60_000) // every minute
  console.log('[DailySummary] started (checks every minute, fires at 23:55 UTC)')
}

export function stopLevelsDailySummary(): void {
  if (summaryInterval) {
    clearInterval(summaryInterval)
    summaryInterval = null
  }
}
