// Variant C (limit-on-rangeEdge experimental copy: 20 conc, 5% target margin,
// limit fill instead of market entry) Daily Breakout paper-trader router.
// Mirrors the same endpoints as /api/breakout-paper{,-b} but routes all reads/writes
// to BreakoutPaperConfigC / BreakoutPaperTradeC. Like B, never mutates the shared
// BreakoutSignal table — A is the only writer.
//
// Жизненный цикл сделки в C принципиально отличается от A/B на этапе входа:
//   - A/B: сразу OPEN при пробое 5m свечи (taker market entry на c.close)
//   - C:   PENDING_LIMIT при появлении сигнала, FILLED только когда цена касается
//          rangeEdge (maker fee, без slip). См. dailyBreakoutLimitTrader.ts.

import { buildBreakoutPaperRouter } from './breakoutPaperRouterFactory'

export default buildBreakoutPaperRouter('C')
