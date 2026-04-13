export function calcSignalPnl(signal: {
  status: string
  type: 'LONG' | 'SHORT'
  entryMin: number
  entryMax: number
  stopLoss: number
  takeProfits: number[]
  leverage: number
}): { text: string; color: string } | null {
  if (signal.status === 'SL_HIT') {
    const entry = (signal.entryMin + signal.entryMax) / 2
    const diff = signal.type === 'LONG'
      ? ((signal.stopLoss - entry) / entry) * 100
      : ((entry - signal.stopLoss) / entry) * 100
    const leveraged = diff * signal.leverage
    return { text: `${leveraged.toFixed(2)}%`, color: 'text-short' }
  }

  if (signal.status.startsWith('TP')) {
    const tpIdx = parseInt(signal.status.replace('TP', '').replace('_HIT', '')) - 1
    const tp = signal.takeProfits[tpIdx]
    if (tp == null) return null
    const entry = (signal.entryMin + signal.entryMax) / 2
    const diff = signal.type === 'LONG'
      ? ((tp - entry) / entry) * 100
      : ((entry - tp) / entry) * 100
    const leveraged = diff * signal.leverage
    return { text: `+${leveraged.toFixed(2)}%`, color: 'text-long' }
  }

  return null
}

export function calcPnlForecast(
  margin: number | null,
  leverage: number,
  entryPrice: number | null,
  targetPrice: number,
  type: 'LONG' | 'SHORT',
  closedPct: number
): number | null {
  if (!margin || !entryPrice || entryPrice === 0) return null
  const remainingMargin = margin * (1 - closedPct / 100)
  if (type === 'LONG') {
    return remainingMargin * leverage * (targetPrice - entryPrice) / entryPrice
  } else {
    return remainingMargin * leverage * (entryPrice - targetPrice) / entryPrice
  }
}

export function calcNetPnl(realizedPnl: number, fees: number, fundingPaid: number): number {
  return realizedPnl - fees - fundingPaid
}

export function calcPnlPct(netPnl: number, amount: number): number {
  return amount > 0 ? (netPnl / amount) * 100 : 0
}

export function calcTpPnl(
  entryPrice: number,
  tpPrice: number,
  type: 'LONG' | 'SHORT',
  leverage: number,
  amount: number,
  tpPercent: number
): { pct: number; usd: number } {
  const direction = type === 'LONG' ? 1 : -1
  const pct = ((tpPrice - entryPrice) * direction / entryPrice) * 100 * leverage
  const portionMargin = amount * (tpPercent / 100)
  const usd = portionMargin * (pct / 100)
  return { pct, usd }
}
