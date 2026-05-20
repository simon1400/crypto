/**
 * Top-level Breakout page — LIVE C only.
 *
 * Paper A/B/C tabs were retired 2026-05-20 — backend trader services are
 * stopped, only the LIVE Binance Futures path runs. The tab strip is gone;
 * we render BreakoutPaper directly with variant='LIVE'.
 */

import BreakoutPaper from './BreakoutPaper'

export default function BreakoutPage() {
  return <BreakoutPaper variant="LIVE" />
}
