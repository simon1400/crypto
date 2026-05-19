/**
 * Lifecycle — paper trader 60s timer + EOD daily summary 1min cron.
 *
 * Single timer per variant. Тики опрашивают БД на новые BreakoutSignal-ы и
 * проигрывают 5m свечи как safety-net — реалтайм SL/TP detection делает
 * breakoutWsTracker через Bybit publicTrade WebSocket. Этот тимер запускается
 * каждую минуту: достаточно частый чтобы быстро открыть новую сделку при
 * появлении сигнала, и держит 5m candle replay как fallback если WS отвалится.
 */

import { BreakoutVariant, logTag } from '../breakoutVariant'
import { runBreakoutPaperCycle } from './cycle'
import { notifySingleVariantOpens } from './notify'
import { sendBreakoutEodSummary } from './eod'

// LIVE is included in the type for routing helpers but doesn't use the paper
// tick — it has its own runLiveCycle in dailyBreakoutLiveC/.
const paperIntervals: Record<BreakoutVariant, NodeJS.Timeout | null> = { A: null, B: null, C: null, LIVE: null }
const paperBusy: Record<BreakoutVariant, boolean> = { A: false, B: false, C: false, LIVE: false }

export function startBreakoutPaperTrader(variant: BreakoutVariant = 'A'): void {
  const tag = logTag(variant)
  if (paperIntervals[variant]) return
  const tick = async () => {
    if (paperBusy[variant]) return
    paperBusy[variant] = true
    try {
      const r = await runBreakoutPaperCycle(variant)
      if (r.opened > 0 || r.updated > 0) {
        console.log(`${tag} tick: opened=${r.opened} updated=${r.updated} delta=${r.depositDelta.toFixed(2)} depo=$${r.deposit.toFixed(2)}`)
      }
      if (r.openedTrades.length > 0) {
        await notifySingleVariantOpens(r.openedTrades, variant)
      }
    } catch (e: any) { console.error(`${tag} tick error:`, e.message) }
    finally { paperBusy[variant] = false }
  }
  // Stagger boot: A starts at +60s, B at +65s, C at +70s — avoids all variants
  // Bybit-fetching the same symbol cluster at the exact same instant on first tick.
  const startDelay = variant === 'A' ? 60_000 : variant === 'B' ? 65_000 : 70_000
  setTimeout(tick, startDelay)
  paperIntervals[variant] = setInterval(tick, 60_000)
  console.log(`${tag} started (tick=60s, realtime SL/TP via WebSocket)`)
}

export function stopBreakoutPaperTrader(variant: BreakoutVariant = 'A'): void {
  const i = paperIntervals[variant]
  if (i) { clearInterval(i); paperIntervals[variant] = null }
}

// === EOD daily summary cron ===
// Single global timer: runs every minute, fires sendBreakoutEodSummary after
// 23:55 UTC each day. Idempotent (marker in BreakoutConfig.lastScanResult), so
// process restarts mid-window don't re-send. Per-trade EXPIRED notifications
// are suppressed in trackOnePaper — this aggregate replaces them.
let eodInterval: NodeJS.Timeout | null = null
let eodBusy = false

export function startBreakoutEodSummary(): void {
  if (eodInterval) return
  const tick = async () => {
    if (eodBusy) return
    eodBusy = true
    try {
      const now = new Date()
      // Only fire in the 5-minute window 23:55–23:59 UTC. Marker prevents repeats.
      const utcHour = now.getUTCHours()
      const utcMin = now.getUTCMinutes()
      if (utcHour !== 23 || utcMin < 55) return
      const utcDate = now.toISOString().slice(0, 10)
      await sendBreakoutEodSummary(utcDate)
    } catch (e: any) {
      console.error('[BreakoutEOD] tick error:', e.message)
    } finally {
      eodBusy = false
    }
  }
  eodInterval = setInterval(tick, 60_000)
  console.log('[BreakoutEOD] started (1min cron, fires once at 23:55 UTC)')
}

export function stopBreakoutEodSummary(): void {
  if (eodInterval) { clearInterval(eodInterval); eodInterval = null }
}
