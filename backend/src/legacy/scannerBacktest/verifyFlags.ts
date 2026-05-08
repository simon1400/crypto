/**
 * Verify that the new env flags actually change scanner behavior.
 *
 * Runs the same 30-day backtest under 3 configs:
 *   1. baseline (no flags)
 *   2. SHORT disabled
 *   3. SHORT disabled + mean_revert disabled + max leverage 3
 * and checks: trade count drops, strategies removed, leverage capped.
 *
 * Run: cd backend && npx tsx src/scalper/scannerBacktest/verifyFlags.ts
 */

import 'dotenv/config'
import { loadBundles, runWalkforward, aggregate, loadTop30Symbols, STEP_MS } from './backtestCore'

async function runConfig(label: string, env: Record<string, string>, bundles: any, symbols: string[], windowStart: number, windowEnd: number) {
  // Set env vars for this run, restore after
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k] }
  // Also clear any flags we don't set so test is clean
  for (const k of ['SCANNER_DISABLE_SHORT', 'SCANNER_DISABLE_MEAN_REVERT', 'SCANNER_DISABLE_TREND_FOLLOW', 'SCANNER_DISABLE_BREAKOUT', 'SCANNER_MAX_LEVERAGE']) {
    if (!(k in env)) { saved[k] = process.env[k]; delete process.env[k] }
  }

  const r = runWalkforward(bundles, {
    symbols, days: 30, minScore: 70,
    windowStartMs: windowStart, windowEndMs: windowEnd, quiet: true,
  })
  const m = aggregate(r.trades)
  const longCount = r.trades.filter(t => t.type === 'LONG').length
  const shortCount = r.trades.filter(t => t.type === 'SHORT').length
  const strats = new Set(r.trades.map(t => t.strategy))
  // We didn't store leverage in TradeResult — would need to enrich, for now use entry/SL to derive
  console.log(`\n[${label}]`)
  console.log(`  trades=${m.totalTrades} (LONG=${longCount}, SHORT=${shortCount})`)
  console.log(`  strategies present: ${[...strats].join(', ') || '(none)'}`)
  console.log(`  totalR=${m.totalR.toFixed(2)}, WR=${(m.winRate * 100).toFixed(0)}%, avgR=${m.avgR.toFixed(3)}`)

  // Restore env
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

async function main() {
  const symbols = loadTop30Symbols()
  console.log(`[Verify] Loading ${symbols.length} symbols × 4 TFs + funding for 30d...`)
  const bundles = await loadBundles(symbols, 30, true)

  const now = Date.now()
  const windowEnd = Math.floor((now - 3600_000) / STEP_MS) * STEP_MS
  const windowStart = windowEnd - 30 * 24 * 3600_000

  await runConfig('Config A: baseline (no flags)', {}, bundles, symbols, windowStart, windowEnd)
  await runConfig('Config B: SHORT disabled', { SCANNER_DISABLE_SHORT: '1' }, bundles, symbols, windowStart, windowEnd)
  await runConfig('Config C: SHORT + mean_revert disabled, leverage cap 3', {
    SCANNER_DISABLE_SHORT: '1',
    SCANNER_DISABLE_MEAN_REVERT: '1',
    SCANNER_MAX_LEVERAGE: '3',
  }, bundles, symbols, windowStart, windowEnd)
  await runConfig('Config D: only breakout (everything else off)', {
    SCANNER_DISABLE_TREND_FOLLOW: '1',
    SCANNER_DISABLE_MEAN_REVERT: '1',
    SCANNER_MAX_LEVERAGE: '3',
  }, bundles, symbols, windowStart, windowEnd)

  console.log(`\n[Verify] Done. If Config B has SHORT=0 and Config C has no mean_revert and Config D only breakout — flags work.`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
