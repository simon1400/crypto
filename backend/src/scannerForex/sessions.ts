export type ForexSession = 'ASIA' | 'LONDON' | 'NY' | 'OVERLAP' | 'DEAD'

// Forex sessions in UTC:
// Asia (Tokyo): 00:00–09:00
// London:       07:00–16:00
// New York:     12:00–21:00
// Overlap:      12:00–16:00 (London + NY, max liquidity)
// Dead zone:    21:00–00:00 (between NY close and Asia open)
//
// Weekend: Fri 21:00 UTC — Sun 21:00 UTC markets are closed
export function currentSession(now = new Date()): ForexSession {
  const hour = now.getUTCHours()

  if (hour >= 12 && hour < 16) return 'OVERLAP'
  if (hour >= 7 && hour < 12) return 'LONDON'
  if (hour >= 16 && hour < 21) return 'NY'
  if (hour >= 0 && hour < 7) return 'ASIA'
  return 'DEAD'
}

// Forex market closes Friday 21:00 UTC (NY session close)
// Reopens Sunday 21:00 UTC (Asia session start in Sydney)
export function isForexMarketOpen(now = new Date()): boolean {
  const day = now.getUTCDay() // 0 = Sun, 6 = Sat
  const hour = now.getUTCHours()

  // Saturday — fully closed
  if (day === 6) return false

  // Friday — closed after 21:00 UTC
  if (day === 5 && hour >= 21) return false

  // Sunday — closed before 21:00 UTC
  if (day === 0 && hour < 21) return false

  return true
}

export function sessionLabel(session: ForexSession): string {
  switch (session) {
    case 'ASIA':
      return 'Asia'
    case 'LONDON':
      return 'London'
    case 'NY':
      return 'NY'
    case 'OVERLAP':
      return 'London/NY'
    case 'DEAD':
      return 'Dead zone'
  }
}
