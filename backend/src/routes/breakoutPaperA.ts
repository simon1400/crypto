// Variant A (legacy prod) Daily Breakout paper-trader router.
// All endpoint logic lives in ./breakoutPaper/; this file just wires the variant.
// /api/breakout-paper/* maps to variant A's tables and behavior.

import { buildBreakoutPaperRouter } from './breakoutPaper/index'

export default buildBreakoutPaperRouter('A')
