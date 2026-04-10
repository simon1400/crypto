/**
 * Scanner-специфичные хелперы.
 * Общий handleBudgetError/asyncHandler/parseIdParam — в ../_helpers
 */

/** Извлекает `Score: N` из поля notes сделки (если был). */
export function parseScoreFromNotes(notes: string | null | undefined): number | null {
  if (!notes) return null
  const m = notes.match(/Score:\s*(\d+)/)
  return m ? Number(m[1]) : null
}

/** Сериализация entry-кластера для API ответа/сохранения в marketContext. */
export function serializeEntryPoint(entry: {
  price: number
  positionPercent: number
  label: string
  cluster: {
    sources: string[]
    totalWeight: number
    distancePercent: number
    fillProbability: number
  }
}) {
  return {
    price: entry.price,
    positionPercent: entry.positionPercent,
    label: entry.label,
    sources: entry.cluster.sources,
    totalWeight: entry.cluster.totalWeight,
    distancePercent: entry.cluster.distancePercent,
    fillProbability: Math.round(entry.cluster.fillProbability * 100),
  }
}
