// Variant B (alternate sizing experiment: 20 conc, 5% target margin) Daily
// Breakout paper-trader router. Mirrors the same endpoints as /api/breakout-paper
// but routes all reads/writes to BreakoutPaperConfigB / BreakoutPaperTradeB.
// Variant B never mutates the shared BreakoutSignal table.

import { buildBreakoutPaperRouter } from './breakoutPaperRouterFactory'

export default buildBreakoutPaperRouter('B')
