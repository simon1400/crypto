# Legacy Code

Files here are NOT compiled (excluded from tsconfig). Kept for reference only.

## scannerBacktest/

Backtest infrastructure for the Scanner module (deleted 2026-05-08 after audit
showed gross +R but net-negative USDT P&L due to fees). Includes:

- `backtestCore.ts` — generic walk-forward engine, can be adapted to other
  strategies. Loads OHLCV bundles, runs scoring pipeline, simulates trades.
- `historicalScannerEngine.ts` — scoring pipeline replay against historical
  candles (depends on deleted `src/scanner/scoring/` — see git history if
  needed to restore).
- `tradeSimulator.ts` — trade outcome simulation (TP1/TP2/TP3 + trailing SL +
  time-stops). Generic, reusable.
- `limitSimulator.ts` — limit order fill simulation.
- `runWalkforward.ts` — full backtest orchestrator.
- `runExperiments.ts` — multi-config sweep (minScore, strategy filter, etc).
- `runDeepAnalysis.ts` — per-month + per-coin breakdown.
- `megaSweep.ts` — 128-config grid with USDT P&L + fee modeling.
- `compareRealVsBacktest.ts` — DB export → bektest comparison.

If you ever need to backtest a new scanner-style strategy, the patterns here
(historical loader integration, fee modeling, walk-forward stepping) are
reusable. The specific scanner imports won't compile until the scanner module
is restored from git.

## Restoration

```
# Restore scannerBacktest:
mv backend/src/legacy/scannerBacktest backend/src/scalper/scannerBacktest
# Remove "src/legacy" from tsconfig.json exclude
# Restore the scanner module from git history if needed:
git log --diff-filter=D --summary | grep "src/scanner/"
```
