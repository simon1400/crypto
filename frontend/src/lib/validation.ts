export function validateTakeProfits(
  tps: { price: string | number; percent: string | number }[]
): { valid: boolean; error: string | null; parsed: { price: number; percent: number }[] } {
  const parsed = tps
    .filter(t => t.price && t.percent)
    .map(t => ({ price: Number(t.price), percent: Number(t.percent) }))

  if (!parsed.length) {
    return { valid: false, error: 'Добавьте хотя бы один Take Profit', parsed: [] }
  }

  const totalPct = parsed.reduce((s, t) => s + t.percent, 0)
  if (totalPct !== 100) {
    return { valid: false, error: `Сумма % должна быть 100 (сейчас ${totalPct})`, parsed }
  }

  return { valid: true, error: null, parsed }
}

export function defaultTpDistribution(tpCount: number): number[] {
  if (tpCount <= 1) return [100]
  if (tpCount === 2) return [50, 50]
  if (tpCount === 3) return [40, 30, 30]
  // For tpCount > 3: first = 40, distribute 60 evenly, adjust last to ensure sum = 100
  const remaining = tpCount - 1
  const baseShare = Math.floor(60 / remaining)
  const result = [40, ...Array(remaining).fill(baseShare)]
  const currentSum = result.reduce((s, v) => s + v, 0)
  result[result.length - 1] += 100 - currentSum
  return result
}
