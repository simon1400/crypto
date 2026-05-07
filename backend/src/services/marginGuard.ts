/**
 * Margin guard — sizing and free-margin enforcement for paper trader.
 *
 * Behavior:
 *   1. Sizing: leverage chosen so margin ≈ targetMarginPct × deposit, capped by per-symbol maxLeverage.
 *      Position size is determined by riskUsd / slDistance (unchanged risk-per-trade model).
 *   2. Margin guard at open time:
 *        - Compute new trade's required margin
 *        - Sum margin already locked by OPEN/TP1_HIT/TP2_HIT trades (using their saved leverage)
 *        - If sum + new <= deposit → open
 *        - Else: try to free margin by closing "winning" trades in priority order:
 *             a) TP2_HIT (most progress, SL at TP1, big plus locked)
 *             b) TP1_HIT (SL at BE, no further risk)
 *             c) OPEN with unrealized P&L >= 0
 *           Close enough to fit; if still not enough → SKIP signal (don't open at all,
 *           do NOT close trades that wouldn't have helped).
 *
 * Why per-symbol maxLeverage: Bybit has hard caps (e.g. AAVE 75x, AVAX 50x). Sizing must
 * respect those even if our targetMarginPct math says otherwise.
 */

// Bybit max leverage (linear USDT perps), captured 2026-05-07 + extended for top-150 universe.
// Conservative defaults for unknown symbols. Can be refreshed via Bybit /v5/market/instruments-info.
const BYBIT_MAX_LEVERAGE: Record<string, number> = {
  // Tier-1 majors (100x)
  BTCUSDT: 100, ETHUSDT: 100, SOLUSDT: 100, XRPUSDT: 100, BNBUSDT: 100,
  DOGEUSDT: 75,
  // Layer-1
  ADAUSDT: 75, AVAXUSDT: 50, DOTUSDT: 50, NEARUSDT: 50, SUIUSDT: 75,
  TONUSDT: 50, TRXUSDT: 50, LTCUSDT: 75, BCHUSDT: 75, XLMUSDT: 50,
  ATOMUSDT: 50, ALGOUSDT: 25, FILUSDT: 50, INJUSDT: 50, ICPUSDT: 50,
  HBARUSDT: 50, APTUSDT: 50, SEIUSDT: 50, TIAUSDT: 50, EGLDUSDT: 25,
  KASUSDT: 25, ZECUSDT: 50, XMRUSDT: 50, DASHUSDT: 25, STXUSDT: 25,
  // L2 / infra
  ARBUSDT: 50, OPUSDT: 50, STRKUSDT: 50, MANTAUSDT: 25, ZKUSDT: 50,
  ZROUSDT: 50, MNTUSDT: 25,
  // DeFi
  LINKUSDT: 75, AAVEUSDT: 75, UNIUSDT: 50, CRVUSDT: 50, PENDLEUSDT: 25,
  LDOUSDT: 25, COMPUSDT: 25, MKRUSDT: 25, SNXUSDT: 25, SUSHIUSDT: 25,
  CAKEUSDT: 25, DYDXUSDT: 25, GMXUSDT: 25, JUPUSDT: 25, ONDOUSDT: 25,
  // AI / DePIN
  RENDERUSDT: 25, RNDRUSDT: 25, GRTUSDT: 25, TAOUSDT: 25, FETUSDT: 25,
  AKTUSDT: 25, ARUSDT: 25, IOUSDT: 25, WLDUSDT: 25, AIXBTUSDT: 25,
  // Memes
  '1000PEPEUSDT': 50, '1000BONKUSDT': 50, '1000FLOKIUSDT': 50, '1000LUNCUSDT': 25,
  WIFUSDT: 50, FARTCOINUSDT: 25, POPCATUSDT: 25, MEWUSDT: 25, BOMEUSDT: 25,
  PNUTUSDT: 25, GOATUSDT: 25, TURBOUSDT: 25, SHIB1000USDT: 25, MOODENGUSDT: 25,
  TRUMPUSDT: 25, BRETTUSDT: 25, NEIROUSDT: 25,
  // New / volatile
  HYPEUSDT: 75, ENAUSDT: 50, BLURUSDT: 50, ORDIUSDT: 50, JTOUSDT: 25,
  PYTHUSDT: 25, ARKMUSDT: 25, AEVOUSDT: 25, ETHFIUSDT: 25, ENSUSDT: 25,
  GALAUSDT: 25, AXSUSDT: 25, APEUSDT: 25, CHZUSDT: 25, JASMYUSDT: 25,
  MASKUSDT: 25, ILVUSDT: 25, BANANAUSDT: 25, NOTUSDT: 25,
  // Universe expansion 2026-05-07
  MUSDT: 25, IPUSDT: 25, SANDUSDT: 25, ETCUSDT: 50, POLUSDT: 50,
  TSTBSCUSDT: 25, VVVUSDT: 25, AEROUSDT: 25,
}
const DEFAULT_MAX_LEVERAGE = 25

export function getMaxLeverage(symbol: string): number {
  return BYBIT_MAX_LEVERAGE[symbol] ?? DEFAULT_MAX_LEVERAGE
}

export interface SizingInput {
  symbol: string
  deposit: number          // current deposit USD
  riskPct: number          // % per trade (e.g. 2)
  targetMarginPct: number  // % deposit per trade margin (e.g. 10)
  entry: number
  sl: number
}

export interface SizingResult {
  riskUsd: number
  positionUnits: number    // base coin
  positionSizeUsd: number  // notional
  leverage: number         // chosen so margin ≈ targetMarginPct × deposit, capped at maxLeverage
  marginUsd: number        // positionSizeUsd / leverage
  cappedByMaxLeverage: boolean
}

export function computeSizing(input: SizingInput): SizingResult | null {
  const { symbol, deposit, riskPct, targetMarginPct, entry, sl } = input
  const slDist = Math.abs(entry - sl)
  if (slDist <= 0 || deposit <= 0) return null

  const riskUsd = (deposit * riskPct) / 100
  const positionUnits = riskUsd / slDist
  const positionSizeUsd = entry * positionUnits
  if (positionSizeUsd <= 0) return null

  // Pick the MINIMUM leverage needed to keep margin <= targetMargin. Higher leverage
  // wastes margin on extra fees (taker/maker fee scales with notional, not margin),
  // and trading fees apply to notional too — so we want the smallest lever that fits.
  // If positionSize <= targetMargin, leverage=1 is enough (no leverage needed).
  // If positionSize > targetMargin, we need lev = positionSize / targetMargin.
  const targetMargin = (deposit * targetMarginPct) / 100
  const idealLeverage = positionSizeUsd / Math.max(targetMargin, 1e-9)
  const maxLev = getMaxLeverage(symbol)
  const leverage = Math.max(1, Math.min(idealLeverage, maxLev))
  const marginUsd = positionSizeUsd / leverage
  const cappedByMaxLeverage = idealLeverage > maxLev + 1e-6

  return { riskUsd, positionUnits, positionSizeUsd, leverage, marginUsd, cappedByMaxLeverage }
}

export interface ExistingTrade {
  id: number
  symbol: string
  status: 'OPEN' | 'TP1_HIT' | 'TP2_HIT' | string
  positionSizeUsd: number
  closedFrac: number       // 0..1, sum of closed slice percents / 100
  leverage: number         // recompute or read from saved field
  unrealizedR: number      // current unrealized R (positive = winning)
  hasTP1: boolean          // status TP1_HIT or TP2_HIT
  hasTP2: boolean          // status TP2_HIT
}

export function activeMargin(t: ExistingTrade): number {
  const remainingPos = t.positionSizeUsd * Math.max(0, 1 - t.closedFrac)
  return remainingPos / Math.max(1e-9, t.leverage)
}

export interface GuardDecision {
  canOpen: boolean
  reason: string
  toClose: number[]        // trade ids to close to free margin (in priority order)
  freedAfterClose: number  // total margin freed by toClose
  marginRequired: number
  marginAvailableBefore: number
  marginAvailableAfter: number
}

/**
 * Evaluates whether a new trade fits within deposit-as-margin budget.
 * If existing margin + new > deposit, attempt to free by closing winners:
 *   priority: TP2_HIT > TP1_HIT > OPEN with unrealizedR >= 0
 * Closing OPEN losing trades (unrealizedR < 0) is NEVER done — that just realises the loss.
 */
export function evaluateOpenWithGuard(
  deposit: number,
  newMarginRequired: number,
  existing: ExistingTrade[],
): GuardDecision {
  const sumActive = existing.reduce((s, t) => s + activeMargin(t), 0)
  const free = deposit - sumActive

  if (newMarginRequired <= free) {
    return {
      canOpen: true,
      reason: 'fits within free margin',
      toClose: [],
      freedAfterClose: 0,
      marginRequired: newMarginRequired,
      marginAvailableBefore: free,
      marginAvailableAfter: free - newMarginRequired,
    }
  }

  // Need to free (newMarginRequired - free) by closing winners.
  const deficit = newMarginRequired - free

  // Build priority list of closable trades.
  const candidates = [...existing]
    .map(t => ({ t, m: activeMargin(t) }))
    .filter(({ t }) => t.hasTP2 || t.hasTP1 || t.unrealizedR >= 0)
    .sort((a, b) => {
      // Higher priority (closed first) gets lower sort number.
      const prio = (t: ExistingTrade) => t.hasTP2 ? 0 : t.hasTP1 ? 1 : 2
      const pa = prio(a.t), pb = prio(b.t)
      if (pa !== pb) return pa - pb
      // Within same priority, prefer to close the one with smaller margin first
      // (keeps largest winners running).
      return a.m - b.m
    })

  let freed = 0
  const toClose: number[] = []
  for (const { t, m } of candidates) {
    if (freed >= deficit) break
    toClose.push(t.id)
    freed += m
  }

  if (freed < deficit) {
    return {
      canOpen: false,
      reason: `insufficient margin (need $${deficit.toFixed(2)} more, only $${freed.toFixed(2)} freeable)`,
      toClose: [],   // do NOT close partial — that would realise gains without opening
      freedAfterClose: 0,
      marginRequired: newMarginRequired,
      marginAvailableBefore: free,
      marginAvailableAfter: free,
    }
  }

  return {
    canOpen: true,
    reason: `free $${freed.toFixed(2)} by closing ${toClose.length} winning trade(s)`,
    toClose,
    freedAfterClose: freed,
    marginRequired: newMarginRequired,
    marginAvailableBefore: free,
    marginAvailableAfter: free + freed - newMarginRequired,
  }
}
