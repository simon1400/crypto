/**
 * Debug variant of smoke test: instrumented funnel — shows where signals die.
 *
 * Run: cd backend && npx tsx src/scalper/scannerBacktest/debugSmoke.ts
 */

import 'dotenv/config'
import { loadHistorical } from '../historicalLoader'
import { loadFundingHistory, fundingAt, FundingPoint } from '../fundingLoader'
import { buildSnapshot, buildBtcRegime, scoreSymbolAt, SymbolHistoricalData } from './historicalScannerEngine'

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT']
const DAYS = 7
const STEP_MS = 12 * 60_000

async function main() {
  const months = Math.ceil(DAYS / 30) + 2
  const bundles = new Map<string, { data: SymbolHistoricalData; funding: FundingPoint[] }>()
  for (const sym of SYMBOLS) {
    const [c5, c15, c1h, c4h, funding] = await Promise.all([
      loadHistorical(sym, '5m', months, 'bybit', 'linear'),
      loadHistorical(sym, '15m', months, 'bybit', 'linear'),
      loadHistorical(sym, '1h', months, 'bybit', 'linear'),
      loadHistorical(sym, '4h', months, 'bybit', 'linear'),
      loadFundingHistory(sym, DAYS + 30),
    ])
    bundles.set(sym, {
      data: { candles5m: c5, candles15m: c15, candles1h: c1h, candles4h: c4h },
      funding,
    })
  }

  const btc = bundles.get('BTCUSDT')!
  const now = Date.now()
  const windowEnd = Math.floor((now - 3600_000) / STEP_MS) * STEP_MS
  const windowStart = windowEnd - DAYS * 24 * 3600_000
  console.log(`[Debug] Window: ${new Date(windowStart).toISOString()} → ${new Date(windowEnd).toISOString()}\n`)

  let stepsTotal = 0
  let stepsWithBtcSnap = 0
  let totalScoringRuns = 0
  let snapshotFails = 0
  let pipelineNulls = 0
  let strategyNulls = 0
  let gotEnriched = 0
  let hardFilterFailed = 0
  const hardFilterReasons: Record<string, number> = {}
  let categoryIgnore = 0
  const setupCategories: Record<string, number> = {}
  const executionTypes: Record<string, number> = {}
  const scoreBuckets: Record<string, number> = { '<40': 0, '40-49': 0, '50-59': 0, '60-69': 0, '70-79': 0, '80-89': 0, '90+': 0 }
  const strategyCounts: Record<string, number> = {}
  const enterNowSignals: Array<{ T: number; coin: string; score: number; cat: string; exec: string; type: string }> = []

  for (let T = windowStart; T <= windowEnd; T += STEP_MS) {
    stepsTotal++
    const btcSnap = buildSnapshot(btc.data, T)
    if (!btcSnap) continue
    stepsWithBtcSnap++
    const regime = buildBtcRegime(btc.data, T)

    for (const sym of SYMBOLS) {
      totalScoringRuns++
      const b = bundles.get(sym)!
      const fnFunding = (ms: number) => fundingAt(b.funding, ms)
      const snap = buildSnapshot(b.data, T)
      if (!snap) { snapshotFails++; continue }

      const enriched = scoreSymbolAt(sym.replace(/USDT$/, ''), b.data, T, {
        regime, btcSnapshot: btcSnap, fundingAt: fnFunding,
      })
      if (!enriched) { pipelineNulls++; continue }
      gotEnriched++

      strategyCounts[enriched.strategy] = (strategyCounts[enriched.strategy] || 0) + 1
      setupCategories[enriched.category] = (setupCategories[enriched.category] || 0) + 1
      executionTypes[enriched.execution_type] = (executionTypes[enriched.execution_type] || 0) + 1

      const s = enriched.setup_score
      if (s < 40) scoreBuckets['<40']++
      else if (s < 50) scoreBuckets['40-49']++
      else if (s < 60) scoreBuckets['50-59']++
      else if (s < 70) scoreBuckets['60-69']++
      else if (s < 80) scoreBuckets['70-79']++
      else if (s < 90) scoreBuckets['80-89']++
      else scoreBuckets['90+']++

      if (!enriched.hard_filter.passed) {
        hardFilterFailed++
        for (const fail of enriched.hard_filter.failures) {
          // First word of failure is the kind
          const key = fail.split(/[—:]/)[0].trim().slice(0, 60)
          hardFilterReasons[key] = (hardFilterReasons[key] || 0) + 1
        }
        continue
      }
      if (enriched.category === 'IGNORE') { categoryIgnore++; continue }

      if (enriched.execution_type === 'ENTER_NOW_LONG' || enriched.execution_type === 'ENTER_NOW_SHORT') {
        enterNowSignals.push({
          T, coin: enriched.coin,
          score: enriched.setup_score,
          cat: enriched.category,
          exec: enriched.execution_type,
          type: enriched.type,
        })
      }
    }
  }

  console.log(`[Debug] === FUNNEL ===`)
  console.log(`Steps total:            ${stepsTotal}`)
  console.log(`Steps with BTC snap:    ${stepsWithBtcSnap}`)
  console.log(`Scoring runs total:     ${totalScoringRuns}`)
  console.log(`  Snapshot fails:       ${snapshotFails}`)
  console.log(`  Pipeline nulls:       ${pipelineNulls} (no strategy raised signal)`)
  console.log(`  Got enriched signal:  ${gotEnriched}`)
  console.log(`    Hard filter failed: ${hardFilterFailed}`)
  console.log(`    IGNORE category:    ${categoryIgnore}`)
  console.log(`    ENTER_NOW signals:  ${enterNowSignals.length}`)

  console.log(`\nStrategies (of ${gotEnriched} enriched):`)
  for (const [k, v] of Object.entries(strategyCounts).sort((a,b) => b[1]-a[1])) {
    console.log(`  ${k.padEnd(15)} ${v}`)
  }

  console.log(`\nSetup categories:`)
  for (const [k, v] of Object.entries(setupCategories).sort((a,b) => b[1]-a[1])) {
    console.log(`  ${k.padEnd(15)} ${v}`)
  }

  console.log(`\nExecution types:`)
  for (const [k, v] of Object.entries(executionTypes).sort((a,b) => b[1]-a[1])) {
    console.log(`  ${k.padEnd(28)} ${v}`)
  }

  console.log(`\nScore distribution:`)
  for (const k of ['<40','40-49','50-59','60-69','70-79','80-89','90+']) {
    console.log(`  ${k.padEnd(8)} ${scoreBuckets[k]}`)
  }

  console.log(`\nHard filter failure reasons (top 10):`)
  for (const [k, v] of Object.entries(hardFilterReasons).sort((a,b) => b[1]-a[1]).slice(0, 10)) {
    console.log(`  [${v}] ${k}`)
  }

  if (enterNowSignals.length > 0) {
    console.log(`\nENTER_NOW signals (first 20):`)
    for (const s of enterNowSignals.slice(0, 20)) {
      console.log(`  ${new Date(s.T).toISOString()} ${s.coin} ${s.type} ${s.exec} score=${s.score} cat=${s.cat}`)
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
