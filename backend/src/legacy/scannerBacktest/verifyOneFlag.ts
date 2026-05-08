/**
 * Single-run flag verification: reads env vars at startup (matching prod).
 * Use cli args or env to choose config:
 *   npx tsx verifyOneFlag.ts                     → baseline
 *   SCANNER_DISABLE_SHORT=1 npx tsx ...          → no SHORT
 *   SCANNER_DISABLE_MEAN_REVERT=1 ...            → no MR
 *   SCANNER_MAX_LEVERAGE=3 ...                   → leverage cap
 *
 * Prints config + signal count over 14 days.
 */

import 'dotenv/config'
import { loadBundles, runWalkforward, aggregate, loadTop30Symbols, STEP_MS } from './backtestCore'

async function main() {
  const flags = {
    SCANNER_DISABLE_SHORT: process.env.SCANNER_DISABLE_SHORT || '(unset)',
    SCANNER_DISABLE_MEAN_REVERT: process.env.SCANNER_DISABLE_MEAN_REVERT || '(unset)',
    SCANNER_DISABLE_TREND_FOLLOW: process.env.SCANNER_DISABLE_TREND_FOLLOW || '(unset)',
    SCANNER_DISABLE_BREAKOUT: process.env.SCANNER_DISABLE_BREAKOUT || '(unset)',
    SCANNER_MAX_LEVERAGE: process.env.SCANNER_MAX_LEVERAGE || '(unset)',
    SCANNER_USE_TOP30: process.env.SCANNER_USE_TOP30 || '(unset)',
  }
  console.log('[Verify] Env flags:')
  for (const [k, v] of Object.entries(flags)) console.log(`  ${k}=${v}`)

  const symbols = loadTop30Symbols()
  // Use a 60-day window centered around March 2026 (which had SHORT signals)
  const days = 60
  const bundles = await loadBundles(symbols, days, true)
  const windowEnd = Date.parse('2026-04-01T00:00:00Z')
  const windowStart = windowEnd - days * 24 * 3600_000

  const r = runWalkforward(bundles, {
    symbols, days, minScore: 70,
    windowStartMs: windowStart, windowEndMs: windowEnd, quiet: true,
  })
  const m = aggregate(r.trades)
  const longC = r.trades.filter(t => t.type === 'LONG').length
  const shortC = r.trades.filter(t => t.type === 'SHORT').length
  const stratSet = new Set(r.trades.map(t => t.strategy))
  console.log(`\nResults (14d, top-30, minScore=70):`)
  console.log(`  trades=${m.totalTrades}  LONG=${longC}  SHORT=${shortC}`)
  console.log(`  strategies in trades: ${[...stratSet].sort().join(', ') || '(none)'}`)
  console.log(`  totalR=${m.totalR.toFixed(2)}  WR=${(m.winRate * 100).toFixed(0)}%`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
