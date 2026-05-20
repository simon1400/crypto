/**
 * Margin guard — sizing and free-margin enforcement for paper trader.
 *
 * Behavior:
 *   1. Sizing: leverage chosen so margin ≈ targetMarginPct × deposit, capped only by
 *      the exchange's notional-tiered bracket (Binance leverageBracket — passed in
 *      via exchangeMaxLeverage). Position size is determined by riskUsd / slDistance.
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
 * Removed 2026-05-20: hardcoded BYBIT_MAX_LEVERAGE table. Binance leverage brackets
 * (fetched via getLeverageBrackets in dailyBreakoutLiveC/brackets.ts) are the
 * authoritative source — they account for both per-symbol AND per-notional caps
 * which the static table couldn't represent. Paper trader doesn't have a real
 * exchange to refuse oversize leverage, so it falls back to Infinity (margin
 * targeting via targetMarginPct is enough — paper backtest doesn't model bracket
 * rejections anyway).
 */

/**
 * Returns the maximum leverage allowed for a symbol when no exchange-side
 * information is available (paper trader). Currently Infinity — sizing then
 * relies on targetMarginPct / availableUsd alone. Live code paths must pass
 * exchangeMaxLeverage from Binance brackets for the real cap.
 */
export function getMaxLeverage(_symbol: string): number {
  return Infinity
}

export interface SizingInput {
  symbol: string
  deposit: number          // wallet deposit USD — full equity incl. open margin.
                           // Used to compute riskUsd (2% of wallet) and target
                           // margin (5% of wallet). NOT availableBalance —
                           // available shrinks as positions open, but each new
                           // trade should still risk % of the full bankroll.
  riskPct: number          // % per trade (e.g. 2)
  targetMarginPct: number  // % deposit per trade margin (e.g. 5)
  entry: number
  sl: number
  // Exchange-side leverage cap for the planned notional. Binance Futures
  // applies a notional-tiered leverage limit (leverageBracket endpoint).
  // Even if our configured symbol cap allows 50x, the bracket for a $9k
  // AVAX trade may only allow 20x — placing 50x gets -2027. Optional so
  // paper trader can omit it (no exchange to refuse).
  exchangeMaxLeverage?: number
  // Free margin currently available on the wallet. If the targetMarginPct
  // computation says we need $251 but only $180 is free, downsize margin
  // to $180 and let leverage climb to keep notional unchanged. When the
  // exchange/symbol max leverage can't accommodate that, sizing returns
  // null (caller treats it as "skip — insufficient free margin"). Optional
  // for paper trader.
  availableUsd?: number
}

export interface SizingResult {
  riskUsd: number
  positionUnits: number    // base coin
  positionSizeUsd: number  // notional
  leverage: number         // chosen so margin ≈ targetMarginPct × deposit, capped at maxLeverage
  marginUsd: number        // positionSizeUsd / leverage
  cappedByMaxLeverage: boolean
  // Set when targetMargin > availableUsd and we downsized margin to fit free
  // funds (leverage bumped accordingly). Surfaces to logs/UI so the user
  // knows why margin is below 5% of wallet on a specific trade.
  downsizedToAvailable?: boolean
}

export function computeSizing(input: SizingInput): SizingResult | null {
  const { deposit, riskPct, targetMarginPct, entry, sl, exchangeMaxLeverage, availableUsd } = input
  const slDist = Math.abs(entry - sl)
  if (slDist <= 0 || deposit <= 0) return null

  const riskUsd = (deposit * riskPct) / 100
  const positionUnits = riskUsd / slDist
  const positionSizeUsd = entry * positionUnits
  if (positionSizeUsd <= 0) return null

  // targetMargin is the desired margin commitment for a "full" sized trade:
  // 5% of the wallet deposit. With deposit=wallet (not available), opening a
  // new trade always targets the same fraction of total bankroll regardless
  // of how much is currently tied up in other positions.
  const targetMargin = (deposit * targetMarginPct) / 100

  // If free margin is below the target, downsize margin to whatever IS free
  // and bump leverage to keep positionSize (and therefore $-risk) unchanged.
  // Honour a small floor — below $5 margin Binance rejects on minNotional
  // anyway and the trade isn't worth opening.
  const MIN_DOWNSIZE_MARGIN = 5
  let effectiveTargetMargin = targetMargin
  let downsizedToAvailable = false
  if (availableUsd !== undefined && availableUsd < targetMargin) {
    if (availableUsd < MIN_DOWNSIZE_MARGIN) return null  // not enough free margin at all
    effectiveTargetMargin = availableUsd
    downsizedToAvailable = true
  }

  // Pick the MINIMUM leverage needed to keep margin <= effectiveTargetMargin.
  // Higher leverage wastes nothing (fees scale on notional, not margin), so
  // we want the smallest lever that fits the margin budget.
  const idealLeverage = positionSizeUsd / Math.max(effectiveTargetMargin, 1e-9)
  // Cap by the exchange's notional-tiered bracket. Live code paths fetch this
  // from Binance leverageBracket (per-notional cap). Paper trader doesn't
  // pass it → no cap (Infinity), which matches paper's simplified model.
  const effectiveMax = exchangeMaxLeverage ?? Infinity
  const leverage = Math.max(1, Math.min(idealLeverage, effectiveMax))
  const marginUsd = positionSizeUsd / leverage
  const cappedByMaxLeverage = idealLeverage > effectiveMax + 1e-6

  // If the leverage cap forced margin ABOVE what's actually free, we can't
  // open this trade — would get -2019 insufficient margin. Skip cleanly.
  if (availableUsd !== undefined && marginUsd > availableUsd + 1e-6) return null

  return { riskUsd, positionUnits, positionSizeUsd, leverage, marginUsd, cappedByMaxLeverage, downsizedToAvailable }
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
  // If set, caller should open with this reduced margin (and recomputed leverage).
  // positionSize and risk stay the same — we just bump leverage to fit available free margin.
  // Only set when the original target margin didn't fit AND no winners could free enough,
  // but the trade still fits at higher leverage within Bybit maxLev.
  downsizedMargin?: number
  downsizedLeverage?: number
}

// Minimum free margin required to consider opening with reduced size.
// Below this, fees + slippage erode the trade's edge — better to skip.
const MIN_FREE_MARGIN_FOR_DOWNSIZE = 10

/**
 * Evaluates whether a new trade fits within deposit-as-margin budget.
 * If existing margin + new > deposit, attempt in order:
 *   1. Free margin by closing winners: TP2_HIT > TP1_HIT > OPEN with unrealizedR >= 0
 *      Closing OPEN losing trades (unrealizedR < 0) is NEVER done — that just realises the loss.
 *   2. If no winners freeable: open with downsized margin = free margin, bumping leverage.
 *      positionSize and risk stay unchanged. Only valid when:
 *        - free >= MIN_FREE_MARGIN_FOR_DOWNSIZE ($10)
 *        - required leverage ≤ Bybit maxLev for the symbol
 */
export function evaluateOpenWithGuard(
  deposit: number,
  newMarginRequired: number,
  existing: ExistingTrade[],
  positionSizeUsd?: number,
  symbol?: string,
): GuardDecision {
  const sumActive = existing.reduce((s, t) => s + activeMargin(t), 0)
  const free = deposit - sumActive

  if (newMarginRequired <= free) {
    return {
      canOpen: true,
      reason: 'хватает свободной маржи',
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
    // Try downsize fallback: open at free margin with higher leverage.
    if (positionSizeUsd != null && symbol != null && free >= MIN_FREE_MARGIN_FOR_DOWNSIZE) {
      const requiredLev = positionSizeUsd / free
      const maxLev = getMaxLeverage(symbol)
      if (requiredLev <= maxLev) {
        return {
          canOpen: true,
          reason: `маржа уменьшена до $${free.toFixed(2)} (целевая $${newMarginRequired.toFixed(2)}), плечо ${requiredLev.toFixed(1)}x`,
          toClose: [],
          freedAfterClose: 0,
          marginRequired: newMarginRequired,
          marginAvailableBefore: free,
          marginAvailableAfter: 0,
          downsizedMargin: free,
          downsizedLeverage: requiredLev,
        }
      }
    }
    return {
      canOpen: false,
      reason: `недостаточно маржи (нужно ещё $${deficit.toFixed(2)}, можно высвободить $${freed.toFixed(2)})`,
      toClose: [],   // do NOT close partial — that would realise gains without opening
      freedAfterClose: 0,
      marginRequired: newMarginRequired,
      marginAvailableBefore: free,
      marginAvailableAfter: free,
    }
  }

  return {
    canOpen: true,
    reason: `высвобождено $${freed.toFixed(2)} закрытием ${toClose.length} прибыльных позиций`,
    toClose,
    freedAfterClose: freed,
    marginRequired: newMarginRequired,
    marginAvailableBefore: free,
    marginAvailableAfter: free + freed - newMarginRequired,
  }
}
