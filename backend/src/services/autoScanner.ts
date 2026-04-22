import { prisma } from '../db/prisma'
import { runScan, isScannerRunning, SCAN_COINS } from '../scanner/coinScanner'

const PUBLIC_APP_URL = 'https://crypto.pechunka.com'
const ALERT_TTL_MS = 2 * 60 * 60 * 1000

let timer: NodeJS.Timeout | null = null
const alertedByKey = new Map<string, { score: number; alertedAt: number }>()

function alertKey(coin: string, type: string): string {
  return `${coin.toUpperCase().replace(/USDT$/, '')}:${type}`
}

async function isCoinInTrade(coin: string, type: string): Promise<boolean> {
  const base = coin.toUpperCase().replace(/USDT$/, '')
  const openTrade = await prisma.trade.findFirst({
    where: {
      type,
      status: { in: ['OPEN', 'PARTIALLY_CLOSED'] },
      OR: [{ coin: base }, { coin: `${base}USDT` }],
    },
    select: { id: true },
  })
  return !!openTrade
}

export function startAutoScanner() {
  scheduleNextTick().catch(err => console.error('[AutoScanner] Initial schedule error:', err.message))
}

export function stopAutoScanner() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

/**
 * Called by settings route when autoScan config changes — resets timer immediately.
 */
export function restartAutoScanner() {
  stopAutoScanner()
  startAutoScanner()
}

async function scheduleNextTick() {
  const config = await prisma.botConfig.findUnique({ where: { id: 1 } })
  if (!config || !config.autoScanEnabled) {
    stopAutoScanner()
    return
  }

  const intervalMs = Math.max(1, config.autoScanIntervalMin) * 60 * 1000
  if (timer) clearTimeout(timer)
  timer = setTimeout(tick, intervalMs)
  console.log(`[AutoScanner] Next tick in ${config.autoScanIntervalMin} min (minScore=${config.autoScanMinScore})`)
}

async function tick() {
  try {
    const config = await prisma.botConfig.findUnique({ where: { id: 1 } })
    if (!config || !config.autoScanEnabled) {
      return
    }

    if (isScannerRunning()) {
      console.log('[AutoScanner] Scanner busy, skip tick')
      return
    }

    const selected = (config.scannerCoins as string[]) || []
    const coins = selected.length > 0 ? selected : SCAN_COINS
    const minScore = config.autoScanMinScore

    console.log(`[AutoScanner] Running scan on ${coins.length} coins, minScore=${minScore}`)
    const { results, savedIds } = await runScan(coins, minScore)

    const hits = results.filter(r => r.signal.score >= minScore)
    console.log(`[AutoScanner] Scan done: ${results.length} passed, ${hits.length} >= ${minScore}`)

    const now = Date.now()
    for (const [key, entry] of alertedByKey) {
      if (now - entry.alertedAt > ALERT_TTL_MS) alertedByKey.delete(key)
    }

    for (const r of hits) {
      const savedId = savedIds[r.signal.coin]
      if (!savedId) continue

      const key = alertKey(r.signal.coin, r.signal.type)
      const prev = alertedByKey.get(key)
      if (prev && r.signal.score <= prev.score) continue

      if (await isCoinInTrade(r.signal.coin, r.signal.type)) {
        console.log(`[AutoScanner] Skip ${key}: already in trade`)
        continue
      }

      try {
        await sendAlert(savedId, config.telegramBotToken, config.telegramChatId, config.telegramEnabled)
        alertedByKey.set(key, { score: r.signal.score, alertedAt: Date.now() })
      } catch (err: any) {
        console.error(`[AutoScanner] Alert failed for signal #${savedId}:`, err.message)
      }
    }
  } catch (err: any) {
    console.error('[AutoScanner] Tick error:', err.message)
  } finally {
    scheduleNextTick().catch(err => console.error('[AutoScanner] Reschedule error:', err.message))
  }
}

async function sendAlert(
  savedId: number,
  botToken: string | null,
  chatId: string | null,
  enabled: boolean,
) {
  if (!enabled || !botToken || !chatId) return

  const sig = await prisma.generatedSignal.findUnique({ where: { id: savedId } })
  if (!sig) return

  const coin = sig.coin.toUpperCase().replace(/USDT$/, '')
  const typeEmoji = sig.type === 'LONG' ? '🟢' : '🔴'
  const mc: any = sig.marketContext || {}

  const setupCat = sig.setupCategory ?? mc.setup_category ?? '—'
  const execType = sig.executionType ?? mc.execution_type ?? '—'
  const coinRegime = mc.coinRegime
    ? `${mc.coinRegime.coinTrend} (BTC ${mc.coinRegime.btcTrend})`
    : '—'
  const marketRegime = `${mc.regime ?? '—'} · ${mc.fearGreedZone ?? '—'} · vol ${mc.volatility ?? '—'}`

  const trig = mc.entry_trigger_result
  const trigLine = trig
    ? `${trig.triggersPassed ?? '?'}/${trig.triggersTotal ?? '?'}${formatTriggerFlags(trig)}`
    : '—'

  const sb = mc.setup_score_breakdown
  const breakdown = sb
    ? `T ${sb.trend ?? '?'} · L ${sb.location ?? '?'} · M ${sb.momentum ?? '?'} · G ${sb.geometry ?? '?'}`
    : '—'

  const fundVal = mc.funding?.rate ?? mc.funding
  const fund = typeof fundVal === 'number' ? fmtPct(fundVal * 100) : '—'
  const oiVal = mc.oi?.change24h ?? mc.oi?.changePct ?? mc.oi
  const oi = typeof oiVal === 'number' ? fmtPct(oiVal) : '—'
  const lsr = mc.lsr && typeof mc.lsr.longPct === 'number' && typeof mc.lsr.shortPct === 'number'
    ? `${Math.round(mc.lsr.longPct)}/${Math.round(mc.lsr.shortPct)}`
    : '—'

  const newsCount = Array.isArray(mc.news) ? mc.news.length : (mc.news?.items?.length ?? 0)
  const liqUsd = mc.liquidations?.totalUsd
  const liqLine = typeof liqUsd === 'number' && liqUsd > 0
    ? `💥 Ликв: $${formatCompact(liqUsd)}`
    : null

  const lines = [
    `🚨 <b>${coin} ${sig.type}</b>  ${typeEmoji} Score ${sig.score}/100`,
    `━━━━━━━━━━━━━━━━━━`,
    `📊 ${sig.strategy} · ${setupCat} · ${execType}`,
    `🌐 Рынок: ${marketRegime}`,
    `🪙 Монета: ${coinRegime}`,
    `🎯 Триггер: ${trigLine}`,
    `📈 Breakdown: ${breakdown}`,
    `💹 Fund ${fund} · OI ${oi} · L:S ${lsr}`,
    newsCount > 0 ? `📰 Новостей: ${newsCount}` : '',
    liqLine || '',
    ``,
    `👉 ${PUBLIC_APP_URL}/scanner?highlight=${savedId}`,
  ].filter(l => l !== '')
  const text = lines.join('\n')

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  })
  const data: any = await res.json()
  if (!data.ok) {
    throw new Error(`Telegram error: ${data.description || 'unknown'}`)
  }
  console.log(`[AutoScanner] Alert sent for ${coin} signal #${savedId} (score ${sig.score})`)
}

function fmtPct(v: number): string {
  const sign = v >= 0 ? '+' : ''
  return `${sign}${v.toFixed(2)}%`
}

function formatCompact(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return v.toFixed(0)
}

function formatTriggerFlags(trig: any): string {
  const flags = trig.flags || trig.checks || null
  if (!flags || typeof flags !== 'object') return ''
  const parts = Object.entries(flags)
    .filter(([, v]) => typeof v === 'boolean')
    .map(([k, v]) => `${v ? '✓' : '✗'}${k}`)
  return parts.length ? ` (${parts.join(' ')})` : ''
}
