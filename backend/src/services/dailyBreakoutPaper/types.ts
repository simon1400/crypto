/**
 * Shared types for the paper trader modules.
 */

export interface PaperConfig {
  id: number
  enabled: boolean
  startingDepositUsd: number
  currentDepositUsd: number
  riskPctPerTrade: number
  // Legacy flat round-trip fee — used as fallback when realistic-model fields are zero
  feesRoundTripPct: number
  // Realistic Binance-style fee model
  feeTakerPct: number      // % per side, taker (entry market + SL/EXPIRED market)
  feeMakerPct: number      // % per side, maker (TP limit fills — sit in book)
  slipTakerPct: number     // % per side slippage on taker fills only
  autoTrailingSL: boolean
  targetMarginPct: number
  marginGuardEnabled: boolean
  marginGuardAutoClose: boolean
  // Circuit breakers: trip if EITHER threshold exceeded for today's UTC closed trades.
  dailyLossLimitPct: number  // sum(netPnlUsd today) / startOfDayDeposit, trip when <= -X%
  dailyLossLimitR: number    // sum(realizedR today), trip when <= -X
  weeklyLossLimitPct: number
  maxConcurrentPositions: number
  maxPositionsPerSymbol: number
  totalTrades: number
  totalWins: number
  totalLosses: number
  totalPnLUsd: number
  peakDepositUsd: number
  maxDrawdownPct: number
}

export interface CloseRecord {
  price: number
  percent: number
  pnlR: number
  pnlUsd: number
  closedAt: string
  reason: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'EXPIRED' | 'MARGIN'
}

export interface OpenedTradeInfo {
  signalId: number
  symbol: string
  side: 'BUY' | 'SELL'
  entryPrice: number
  stopLoss: number
  tpLadder: number[]
  rangeHigh: number
  rangeLow: number
  rangeSize: number
  riskPctPerTrade: number
  riskUsd: number
  positionSizeUsd: number
  positionUnits: number
  leverage: number
  marginUsd: number
  depositUsd: number
  targetMarginPct: number
  cappedByMaxLeverage: boolean
  reason: string
}
