import { prisma } from '../db/prisma'

// === Post-TP1 Analytics ===
// Answers critical questions about trade management quality:
// - How often TP1 was hit before BE/trailing exit?
// - Average MFE after TP1
// - How often BE/trailing exit happened before TP2/TP3 territory reached?
// - Is trailing too aggressive?

export interface PostTp1Stats {
  totalTrades: number
  tp1HitCount: number
  tp1HitRate: number           // % of trades that hit TP1
  // After TP1 outcomes
  tp2AfterTp1Count: number
  tp2AfterTp1Rate: number     // % of TP1 trades that went on to TP2
  tp3AfterTp1Count: number
  tp3AfterTp1Rate: number
  beExitAfterTp1Count: number  // stopped at BE after TP1
  beExitAfterTp1Rate: number
  trailingExitCount: number    // stopped by trailing after TP1+
  trailingExitRate: number
  // MFE analysis
  avgMfe: number               // average MFE across all closed trades
  avgMfeAfterTp1: number       // average MFE for trades that hit TP1
  avgMaeAfterTp1: number       // average MAE after TP1 (shows how much gives back)
  // Time analysis
  avgTimeInTradeMin: number
  avgTimeToTp1Min: number | null
  // Trailing tightness: how often BE/trailing closed before price later reached TP2+
  potentialTp2Missed: number   // trades where MFE > TP2 level but exited at BE/trailing
  potentialTp2MissedRate: number
}

export interface SetupPerformance {
  setupCategory: string
  count: number
  avgMfe: number
  avgMae: number
  winRate: number
  avgRR: number
  tp1HitRate: number
}

export interface EntryModelComparison {
  model: string
  count: number
  avgPnlPct: number
  winRate: number
  avgMfe: number
  avgMae: number
}

// Extract Score from "Scanner signal #N | strategy | Score: NN" notes
function extractScore(notes: string | null | undefined): number | null {
  if (!notes) return null
  const m = notes.match(/Score:\s*(\d+)/)
  return m ? Number(m[1]) : null
}

// Fetch post-TP1 analytics for closed trades.
// minScore filters scanner trades by the Score embedded in notes.
// Manual trades (no Score) are EXCLUDED when minScore > 0 — analytics is about
// scanner setup quality, not user discretion.
export async function getPostTp1Analytics(
  daysBack = 30,
  source?: string,
  minScore = 0,
): Promise<PostTp1Stats> {
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
  const where: any = {
    status: { in: ['CLOSED', 'SL_HIT'] },
    closedAt: { gte: since },
  }
  if (source) where.source = source

  let trades = await prisma.trade.findMany({ where })

  if (minScore > 0) {
    trades = trades.filter(t => {
      const s = extractScore(t.notes)
      return s != null && s >= minScore
    })
  }

  const totalTrades = trades.length
  if (totalTrades === 0) return emptyStats()

  const tp1Trades = trades.filter(t => t.tp1HitTimestamp != null)
  const tp1HitCount = tp1Trades.length

  const tp2AfterTp1 = tp1Trades.filter(t => t.tp2HitTimestamp != null)
  const tp3AfterTp1 = tp1Trades.filter(t => t.tp3HitTimestamp != null)

  const beExitAfterTp1 = tp1Trades.filter(t => t.exitReason === 'BE_STOP')
  const trailingExits = tp1Trades.filter(t => t.exitReason === 'TRAILING_STOP')

  const withMfe = trades.filter(t => t.mfe != null)
  const avgMfe = withMfe.length > 0 ? avg(withMfe.map(t => t.mfe!)) : 0
  const tp1WithMfe = tp1Trades.filter(t => t.mfe != null)
  const avgMfeAfterTp1 = tp1WithMfe.length > 0 ? avg(tp1WithMfe.map(t => t.mfe!)) : 0
  const tp1WithMae = tp1Trades.filter(t => t.mae != null)
  const avgMaeAfterTp1 = tp1WithMae.length > 0 ? avg(tp1WithMae.map(t => t.mae!)) : 0

  const withTime = trades.filter(t => t.timeInTradeMin != null)
  const avgTimeInTradeMin = withTime.length > 0 ? avg(withTime.map(t => t.timeInTradeMin!)) : 0

  const tp1WithTime = tp1Trades.filter(t => t.tp1HitTimestamp && t.openedAt)
  const avgTimeToTp1Min = tp1WithTime.length > 0
    ? avg(tp1WithTime.map(t => (t.tp1HitTimestamp!.getTime() - (t.openedAt?.getTime() || t.createdAt.getTime())) / 60000))
    : null

  // Potential TP2 missed: MFE was above TP2 level but exited at BE/trailing
  const potentialTp2Missed = tp1Trades.filter(t => {
    if (t.exitReason !== 'BE_STOP' && t.exitReason !== 'TRAILING_STOP') return false
    const tps = (t.takeProfits as any[]) || []
    if (tps.length < 2 || t.mfe == null) return false
    const tp2 = tps[1]?.price
    if (!tp2) return false
    const isLong = t.type === 'LONG'
    const tp2Pct = ((tp2 - t.entryPrice) / t.entryPrice) * 100 * (isLong ? 1 : -1)
    return t.mfe >= tp2Pct
  })

  return {
    totalTrades,
    tp1HitCount,
    tp1HitRate: pct(tp1HitCount, totalTrades),
    tp2AfterTp1Count: tp2AfterTp1.length,
    tp2AfterTp1Rate: pct(tp2AfterTp1.length, tp1HitCount),
    tp3AfterTp1Count: tp3AfterTp1.length,
    tp3AfterTp1Rate: pct(tp3AfterTp1.length, tp1HitCount),
    beExitAfterTp1Count: beExitAfterTp1.length,
    beExitAfterTp1Rate: pct(beExitAfterTp1.length, tp1HitCount),
    trailingExitCount: trailingExits.length,
    trailingExitRate: pct(trailingExits.length, tp1HitCount),
    avgMfe: round2(avgMfe),
    avgMfeAfterTp1: round2(avgMfeAfterTp1),
    avgMaeAfterTp1: round2(avgMaeAfterTp1),
    avgTimeInTradeMin: round2(avgTimeInTradeMin),
    avgTimeToTp1Min: avgTimeToTp1Min != null ? round2(avgTimeToTp1Min) : null,
    potentialTp2Missed: potentialTp2Missed.length,
    potentialTp2MissedRate: pct(potentialTp2Missed.length, tp1HitCount),
  }
}

// Performance breakdown by setup category.
// minScore filters by GeneratedSignal.setupScore.
export async function getSetupPerformance(daysBack = 30, minScore = 0): Promise<SetupPerformance[]> {
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)

  const where: any = {
    status: { in: ['CLOSED', 'SL_HIT'] },
    closedAt: { gte: since },
    setupCategory: { not: null },
  }
  if (minScore > 0) where.setupScore = { gte: minScore }

  const signals = await prisma.generatedSignal.findMany({ where })

  const byCategory = groupBy(signals, s => s.setupCategory || 'UNKNOWN')
  const results: SetupPerformance[] = []

  for (const [cat, sigs] of Object.entries(byCategory)) {
    const withMfe = sigs.filter(s => s.mfe != null)
    const withMae = sigs.filter(s => s.mae != null)
    const winners = sigs.filter(s => s.realizedPnl > 0)

    results.push({
      setupCategory: cat,
      count: sigs.length,
      avgMfe: withMfe.length > 0 ? round2(avg(withMfe.map(s => s.mfe!))) : 0,
      avgMae: withMae.length > 0 ? round2(avg(withMae.map(s => s.mae!))) : 0,
      winRate: pct(winners.length, sigs.length),
      avgRR: sigs.length > 0 ? round2(avg(sigs.map(s => {
        const tps = (s.takeProfits as any[]) || []
        return tps[0]?.rr || 0
      }))) : 0,
      tp1HitRate: pct(sigs.filter(s => s.hitTp1).length, sigs.length),
    })
  }

  return results.sort((a, b) => b.count - a.count)
}

// Compare entry model performance.
// minScore filters by GeneratedSignal.setupScore.
export async function getEntryModelComparison(daysBack = 30, minScore = 0): Promise<EntryModelComparison[]> {
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)

  const where: any = {
    status: { in: ['CLOSED', 'SL_HIT'] },
    closedAt: { gte: since },
    entryModel: { not: null },
  }
  if (minScore > 0) where.setupScore = { gte: minScore }

  const signals = await prisma.generatedSignal.findMany({ where })

  const byModel = groupBy(signals, s => s.entryModel || 'unknown')
  const results: EntryModelComparison[] = []

  for (const [model, sigs] of Object.entries(byModel)) {
    const winners = sigs.filter(s => s.realizedPnl > 0)
    const withMfe = sigs.filter(s => s.mfe != null)
    const withMae = sigs.filter(s => s.mae != null)
    const withPnl = sigs.filter(s => s.amount > 0)

    results.push({
      model,
      count: sigs.length,
      avgPnlPct: withPnl.length > 0 ? round2(avg(withPnl.map(s => (s.realizedPnl / s.amount) * 100))) : 0,
      winRate: pct(winners.length, sigs.length),
      avgMfe: withMfe.length > 0 ? round2(avg(withMfe.map(s => s.mfe!))) : 0,
      avgMae: withMae.length > 0 ? round2(avg(withMae.map(s => s.mae!))) : 0,
    })
  }

  return results
}

// Helpers
function avg(values: number[]): number {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0
}

function pct(part: number, total: number): number {
  return total > 0 ? round2((part / total) * 100) : 0
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function groupBy<T>(arr: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {}
  for (const item of arr) {
    const key = keyFn(item)
    if (!result[key]) result[key] = []
    result[key].push(item)
  }
  return result
}

function emptyStats(): PostTp1Stats {
  return {
    totalTrades: 0, tp1HitCount: 0, tp1HitRate: 0,
    tp2AfterTp1Count: 0, tp2AfterTp1Rate: 0,
    tp3AfterTp1Count: 0, tp3AfterTp1Rate: 0,
    beExitAfterTp1Count: 0, beExitAfterTp1Rate: 0,
    trailingExitCount: 0, trailingExitRate: 0,
    avgMfe: 0, avgMfeAfterTp1: 0, avgMaeAfterTp1: 0,
    avgTimeInTradeMin: 0, avgTimeToTp1Min: null,
    potentialTp2Missed: 0, potentialTp2MissedRate: 0,
  }
}
