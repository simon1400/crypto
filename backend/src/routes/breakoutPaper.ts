// Variant A (legacy prod) Daily Breakout paper-trader router.
// All endpoint logic lives in breakoutPaperRouterFactory; this file just wires
// the variant. /api/breakout-paper/* maps to variant A's tables and behavior.

import { buildBreakoutPaperRouter } from './breakoutPaperRouterFactory'

export default buildBreakoutPaperRouter('A')
