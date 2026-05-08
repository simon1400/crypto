/**
 * Generate human-readable markdown report from scanner_experiments_*.json
 *
 * Reads the most recent (or specified) experiments file and prints
 * a comprehensive markdown comparison.
 *
 * Run: cd backend && npx tsx src/scalper/scannerBacktest/reportExperiments.ts [path-to-json]
 */

import * as fs from 'fs'
import * as path from 'path'

const OUT_DIR = path.join(__dirname, '../../../data/backtest')

function findMostRecent(): string {
  const files = fs.readdirSync(OUT_DIR).filter(f => f.startsWith('scanner_experiments_') && f.endsWith('.json'))
  if (files.length === 0) throw new Error('No scanner_experiments_*.json found')
  files.sort().reverse()
  return path.join(OUT_DIR, files[0])
}

interface BucketStats { trades: number; wins: number; totalR: number; avgR: number; winRate: number }
interface AggregateMetrics {
  totalTrades: number; wins: number; losses: number
  totalR: number; avgR: number; winRate: number
  maxDrawdownR: number; sharpe: number
  byStrategy: Record<string, BucketStats>
  bySetupCategory: Record<string, BucketStats>
  byExecutionType: Record<string, BucketStats>
  byScoreBand: Record<string, BucketStats>
  byType: Record<string, BucketStats>
  byExitReason: Record<string, number>
  byCoin: Record<string, BucketStats>
}
interface Experiment {
  name: string; description: string
  config: any
  metrics: AggregateMetrics
  totalSignals: number; signalsRejectedByFilter: number
  runTimeSec: number
  windowStart: number; windowEnd: number
}
interface Report {
  generatedAt: string
  daysTotal: number
  windowStart: number; windowEnd: number; train90: number
  symbols: string[]
  experiments: Experiment[]
  equityCurveBaseline: { time: number; equityR: number }[]
}

function pct(n: number) { return (n * 100).toFixed(1) + '%' }
function r(n: number) { return n >= 0 ? '+' + n.toFixed(2) : n.toFixed(2) }

function main() {
  const file = process.argv[2] || findMostRecent()
  console.log(`# Scanner Backtest — All Experiments Report`)
  console.log(`Source: \`${path.basename(file)}\`\n`)

  const data: Report = JSON.parse(fs.readFileSync(file, 'utf-8'))
  console.log(`**Generated:** ${data.generatedAt}`)
  console.log(`**Period:** ${new Date(data.windowStart).toISOString().slice(0, 10)} → ${new Date(data.windowEnd).toISOString().slice(0, 10)} (${data.daysTotal} days)`)
  console.log(`**TRAIN cutoff:** ${new Date(data.train90).toISOString().slice(0, 10)} (75% / 25% split)`)
  console.log(`**Symbols:** ${data.symbols.length} (${data.symbols.slice(0, 6).join(', ')}, ...)`)
  console.log()

  // Master comparison
  console.log(`## Master Comparison\n`)
  console.log(`| Experiment | Trades | WR | Total R | Avg R | Max DD | Sharpe |`)
  console.log(`|---|---:|---:|---:|---:|---:|---:|`)
  for (const e of data.experiments) {
    const m = e.metrics
    console.log(`| ${e.name} | ${m.totalTrades} | ${pct(m.winRate)} | ${r(m.totalR)} | ${m.avgR.toFixed(3)} | ${m.maxDrawdownR.toFixed(2)} | ${m.sharpe.toFixed(3)} |`)
  }
  console.log()

  // Section: Score sweep
  const sweep = data.experiments.filter(e => e.name.startsWith('sweep_minScore_'))
  if (sweep.length > 0) {
    console.log(`## 1. minScore Sweep\n`)
    console.log(`| minScore | Trades | WR | Total R | Avg R | Max DD | Sharpe |`)
    console.log(`|---:|---:|---:|---:|---:|---:|---:|`)
    for (const e of sweep) {
      const m = e.metrics
      console.log(`| ${e.config.minScore} | ${m.totalTrades} | ${pct(m.winRate)} | ${r(m.totalR)} | ${m.avgR.toFixed(3)} | ${m.maxDrawdownR.toFixed(2)} | ${m.sharpe.toFixed(3)} |`)
    }
    const best = [...sweep].sort((a, b) => b.metrics.sharpe - a.metrics.sharpe)[0]
    console.log(`\n**Best by Sharpe:** minScore=${best.config.minScore} (Sharpe=${best.metrics.sharpe})`)
    const bestR = [...sweep].sort((a, b) => b.metrics.totalR - a.metrics.totalR)[0]
    console.log(`**Best by Total R:** minScore=${bestR.config.minScore} (totalR=${bestR.metrics.totalR})`)
    console.log()
  }

  // Section: SHORT filter
  const e2a = data.experiments.find(e => e.name === 'exp2_baseline')
  const e2b = data.experiments.find(e => e.name === 'exp2_short_trend_only')
  if (e2a && e2b) {
    console.log(`## 2. SHORT Filter Experiment\n`)
    console.log(`| Config | Trades | Total R | WR | Avg R | Sharpe |`)
    console.log(`|---|---:|---:|---:|---:|---:|`)
    console.log(`| Baseline (all SHORT allowed) | ${e2a.metrics.totalTrades} | ${r(e2a.metrics.totalR)} | ${pct(e2a.metrics.winRate)} | ${e2a.metrics.avgR.toFixed(3)} | ${e2a.metrics.sharpe.toFixed(3)} |`)
    console.log(`| SHORT only via trend_follow | ${e2b.metrics.totalTrades} | ${r(e2b.metrics.totalR)} | ${pct(e2b.metrics.winRate)} | ${e2b.metrics.avgR.toFixed(3)} | ${e2b.metrics.sharpe.toFixed(3)} |`)
    const dR = e2b.metrics.totalR - e2a.metrics.totalR
    const dT = e2b.metrics.totalTrades - e2a.metrics.totalTrades
    console.log(`\n**Delta:** ${r(dR)}R, ${dT > 0 ? '+' : ''}${dT} trades`)
    console.log()

    // SHORT subgroup detail (from baseline experiment buckets — by strategy among SHORT type)
    console.log(`### SHORT subgroup breakdown (baseline)\n`)
    console.log(`Looking at experiments-level buckets only — see runs JSON for full per-trade detail.`)
    console.log()
  }

  // Section: Equity curve summary
  if (data.equityCurveBaseline.length > 0) {
    console.log(`## 3. Equity Curve (baseline minScore=70)\n`)
    const c = data.equityCurveBaseline
    const peak = Math.max(...c.map(p => p.equityR))
    const peakIdx = c.findIndex(p => p.equityR === peak)
    const trough = Math.min(...c.map(p => p.equityR))
    const troughIdx = c.findIndex(p => p.equityR === trough)
    console.log(`- **Trades plotted:** ${c.length}`)
    console.log(`- **Final equity:** ${r(c[c.length - 1].equityR)}R`)
    console.log(`- **Peak:** ${r(peak)}R at trade #${peakIdx + 1} (${new Date(c[peakIdx].time).toISOString().slice(0, 10)})`)
    console.log(`- **Trough:** ${r(trough)}R at trade #${troughIdx + 1} (${new Date(c[troughIdx].time).toISOString().slice(0, 10)})`)
    // Sample 10 evenly spaced points
    const samples = []
    for (let i = 0; i < 10; i++) {
      const idx = Math.floor((i / 9) * (c.length - 1))
      samples.push(c[idx])
    }
    console.log(`\n10 evenly-spaced equity samples:\n`)
    console.log(`| # | Date | Equity R |`)
    console.log(`|---:|---|---:|`)
    samples.forEach((s, i) => {
      const idx = Math.floor((i / 9) * (c.length - 1))
      console.log(`| ${idx + 1} | ${new Date(s.time).toISOString().slice(0, 10)} | ${r(s.equityR)} |`)
    })
    console.log(`\nFull CSV: \`backend/data/backtest/scanner_equity_baseline.csv\`\n`)
  }

  // Section: LIMIT execution
  const e4 = data.experiments.find(e => e.name === 'exp4_limit_enabled')
  if (e4) {
    console.log(`## 4. LIMIT Execution\n`)
    console.log(`Enabled simulated LIMIT fills with TTL=240min and structural invalidation.\n`)
    const m = e4.metrics
    console.log(`**Combined (market + limit):** ${m.totalTrades} trades, ${r(m.totalR)}R, WR ${pct(m.winRate)}, Sharpe ${m.sharpe.toFixed(3)}\n`)
    if (m.byExecutionType) {
      console.log(`### By execution type\n`)
      console.log(`| Execution Type | Trades | Total R | WR | Avg R |`)
      console.log(`|---|---:|---:|---:|---:|`)
      for (const [k, b] of Object.entries(m.byExecutionType).sort((a, b) => b[1].totalR - a[1].totalR)) {
        console.log(`| ${k} | ${b.trades} | ${r(b.totalR)} | ${pct(b.winRate)} | ${b.avgR.toFixed(3)} |`)
      }
    }
    console.log()
  }

  // Section: Walk-forward TRAIN/TEST
  const eOpt = data.experiments.find(e => e.name === 'exp5_test_optimized')
  const eBase = data.experiments.find(e => e.name === 'exp5_test_baseline70')
  if (eOpt && eBase) {
    console.log(`## 5. Walk-forward TRAIN/TEST split\n`)
    console.log(`Selection: best minScore on TRAIN window (by Sharpe), validated on TEST window (last 25%).\n`)
    console.log(`**Selected minScore:** ${eOpt.config.minScore}\n`)
    console.log(`| TEST result | Trades | Total R | WR | Avg R | Sharpe | Max DD |`)
    console.log(`|---|---:|---:|---:|---:|---:|---:|`)
    console.log(`| Optimized (minScore=${eOpt.config.minScore}) | ${eOpt.metrics.totalTrades} | ${r(eOpt.metrics.totalR)} | ${pct(eOpt.metrics.winRate)} | ${eOpt.metrics.avgR.toFixed(3)} | ${eOpt.metrics.sharpe.toFixed(3)} | ${eOpt.metrics.maxDrawdownR.toFixed(2)} |`)
    console.log(`| Baseline (minScore=70) | ${eBase.metrics.totalTrades} | ${r(eBase.metrics.totalR)} | ${pct(eBase.metrics.winRate)} | ${eBase.metrics.avgR.toFixed(3)} | ${eBase.metrics.sharpe.toFixed(3)} | ${eBase.metrics.maxDrawdownR.toFixed(2)} |`)
    console.log()
    const dR = eOpt.metrics.totalR - eBase.metrics.totalR
    console.log(`**Out-of-sample delta:** ${r(dR)}R (${dR >= 0 ? 'optimization helped' : 'optimization made it worse — overfit'})`)
    console.log()
  }

  // Section: Strategy breakdown for first non-empty experiment with byStrategy
  const baselineExp = data.experiments.find(e => e.name === 'exp2_baseline') || data.experiments[0]
  if (baselineExp?.metrics.byStrategy) {
    console.log(`## Strategy breakdown (baseline minScore=70)\n`)
    console.log(`| Strategy | Trades | WR | Total R | Avg R |`)
    console.log(`|---|---:|---:|---:|---:|`)
    for (const [k, b] of Object.entries(baselineExp.metrics.byStrategy).sort((a, b) => b[1].totalR - a[1].totalR)) {
      console.log(`| ${k} | ${b.trades} | ${pct(b.winRate)} | ${r(b.totalR)} | ${b.avgR.toFixed(3)} |`)
    }
    console.log()
  }
}

main()
