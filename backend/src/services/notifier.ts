import { prisma } from '../db/prisma'
import { getMaxLeverage } from './marginGuard'

export type OrderAction =
  | 'BREAKOUT_OPENED'
  | 'BREAKOUT_TP1_HIT'
  | 'BREAKOUT_TP2_HIT'
  | 'BREAKOUT_TP3_HIT'
  | 'BREAKOUT_SL_HIT'
  | 'BREAKOUT_EOD_CLOSED'
  | 'BREAKOUT_EOD_SURVIVING'

const NOTIFY_ACTIONS: Set<OrderAction> = new Set([
  'BREAKOUT_OPENED',
  'BREAKOUT_TP1_HIT',
  'BREAKOUT_TP2_HIT',
  'BREAKOUT_TP3_HIT',
  'BREAKOUT_SL_HIT',
  'BREAKOUT_EOD_CLOSED',
  'BREAKOUT_EOD_SURVIVING',
])

export interface VariantOpenInfo {
  variant: 'A' | 'B'
  depositUsd: number
  riskPctPerTrade: number
  riskUsd: number
  positionSizeUsd: number
  positionUnits: number
  marginUsd: number
  leverage: number
  cappedByMaxLeverage: boolean
  targetMarginPct: number
}

export interface EodTradeRow {
  symbol: string
  side: 'BUY' | 'SELL'
  pnlUsd: number      // net PnL in USD over the lifetime of the trade
  pnlR: number        // realized R
}

export interface EodVariantSummary {
  variant: 'A' | 'B'
  trades: EodTradeRow[]
  totalPnlUsd: number
  depositUsd: number
}

function formatMessage(action: OrderAction, details?: Record<string, any>): string {
  const d = details || {}

  switch (action) {
    case 'BREAKOUT_OPENED': {
      const sideEmoji = d.side === 'BUY' ? '🟢' : '🔴'
      const sideText = d.side === 'BUY' ? 'LONG' : 'SHORT'
      const sym = d.symbol
      const variants: VariantOpenInfo[] = (d.variants as VariantOpenInfo[]) ?? []
      const coin = sym.replace('USDT', '')
      const maxLev = getMaxLeverage(sym)

      const variantBlocks = variants.map((v) => {
        const lvNote = v.cappedByMaxLeverage ? ` (max ${maxLev}x)` : ''
        return [
          `<b>Вариант ${v.variant}</b>`,
          `💰 Депо    <code>$${v.depositUsd.toFixed(2)}</code>  · Риск ${v.riskPctPerTrade}% (<code>$${v.riskUsd.toFixed(2)}</code>)`,
          `📐 Размер  <code>$${v.positionSizeUsd.toFixed(2)}</code>  · ${v.positionUnits.toFixed(6)} ${coin}`,
          `🪙 Маржа   <code>$${v.marginUsd.toFixed(2)}</code>  (~${v.targetMarginPct}% депо)`,
          `⚡ Плечо   <code>${v.leverage.toFixed(1)}x</code>${lvNote}`,
        ].join('\n')
      }).join('\n\n')

      return [
        `${sideEmoji} <b>${sym}</b> <b>${sideText}</b>  · 🚀 Daily Breakout`,
        `━━━━━━━━━━━━━━━━━━`,
        variantBlocks,
        d.reason ? `\n<i>${d.reason}</i>` : '',
      ].filter((l) => l !== '').join('\n')
    }

    case 'BREAKOUT_TP1_HIT':
    case 'BREAKOUT_TP2_HIT':
    case 'BREAKOUT_TP3_HIT': {
      const n = String(action).replace('BREAKOUT_TP', '').replace('_HIT', '')
      const sym = d.symbol
      const dec = sym.includes('USDT') ? 2 : 5
      // Full trailing: TP1→BE, TP2→TP1, TP3→TP2
      const beNote = n === '1' ? '\n🛡 SL → BE' : `\n🛡 SL → TP${parseInt(n) - 1}`
      const pnlUsdLine = typeof d.pnlUsd === 'number'
        ? `\n💵 $        <b>${d.pnlUsd >= 0 ? '+' : ''}$${d.pnlUsd.toFixed(2)}</b>` : ''
      const totalUsdLine = typeof d.realizedPnlUsd === 'number'
        ? `\nΣ $       ${d.realizedPnlUsd >= 0 ? '+' : ''}$${d.realizedPnlUsd.toFixed(2)}` : ''
      const depoLine = typeof d.depositUsd === 'number'
        ? `\n💼 Депо    <code>$${d.depositUsd.toFixed(2)}</code>` : ''
      return [
        `✅ <b>${sym}</b>  TP${n} сработал`,
        `━━━━━━━━━━━━━━━━━━`,
        `💰 Цена   <code>${(d.tpPrice as number).toFixed(dec)}</code>`,
        `📊 Закрыто  ${(d.percent as number).toFixed(0)}%`,
        `📈 R        <b>${d.pnlR >= 0 ? '+' : ''}${(d.pnlR as number).toFixed(2)}R</b>${pnlUsdLine}`,
        `Σ R       ${d.realizedR >= 0 ? '+' : ''}${(d.realizedR as number).toFixed(2)}R${totalUsdLine}${depoLine}${beNote}`,
      ].join('\n')
    }

    case 'BREAKOUT_SL_HIT': {
      const sym = d.symbol
      const dec = sym.includes('USDT') ? 2 : 5
      // trailLevel: 0=full loss, 1=BE, 2=locked TP1, 3=locked TP2
      const trail: number = typeof d.trailLevel === 'number' ? d.trailLevel : (d.realizedR >= 0 ? 1 : 0)
      const emoji = trail === 0 ? '🔴' : '🟡'
      const totalUsdLine = typeof d.realizedPnlUsd === 'number'
        ? `\n💵 Σ $    <b>${d.realizedPnlUsd >= 0 ? '+' : ''}$${d.realizedPnlUsd.toFixed(2)}</b>` : ''
      const depoLine = typeof d.depositUsd === 'number'
        ? `\n💼 Депо   <code>$${d.depositUsd.toFixed(2)}</code>` : ''
      return [
        `${emoji} <b>${sym}</b>  ${d.reasonText ?? 'SL'}`,
        `━━━━━━━━━━━━━━━━━━`,
        `📍 Цена   <code>${(d.slPrice as number).toFixed(dec)}</code>`,
        `📊 Σ R    <b>${d.realizedR >= 0 ? '+' : ''}${(d.realizedR as number).toFixed(2)}R</b>${totalUsdLine}${depoLine}`,
      ].join('\n')
    }

    case 'BREAKOUT_EOD_CLOSED': {
      // d.summaries: EodVariantSummary[]; d.utcDate: string
      const summaries: EodVariantSummary[] = (d.summaries as EodVariantSummary[]) ?? []
      const dateStr = d.utcDate ?? ''
      if (summaries.every((s) => s.trades.length === 0)) {
        return `⏱ <b>EOD ${dateStr}</b>  · нет закрытых сделок`
      }
      const blocks = summaries.map((s) => {
        if (s.trades.length === 0) {
          return `<b>Вариант ${s.variant}</b>  · нет закрытых сделок`
        }
        const sign = (n: number) => `${n >= 0 ? '+' : ''}$${n.toFixed(2)}`
        const lines = s.trades.map((t) => {
          const sideEmoji = t.side === 'BUY' ? '🟢' : '🔴'
          const pnlR = `${t.pnlR >= 0 ? '+' : ''}${t.pnlR.toFixed(2)}R`
          return `   ${sideEmoji} ${t.symbol} → <b>${sign(t.pnlUsd)}</b>  (${pnlR})`
        }).join('\n')
        return [
          `<b>Вариант ${s.variant}</b>  · Σ <b>${sign(s.totalPnlUsd)}</b>  · 💼 <code>$${s.depositUsd.toFixed(2)}</code>`,
          lines,
        ].join('\n')
      }).join('\n\n')
      return [
        `⏱ <b>EOD ${dateStr}</b>  · закрытые сделки`,
        `━━━━━━━━━━━━━━━━━━`,
        blocks,
      ].join('\n')
    }

    case 'BREAKOUT_EOD_SURVIVING': {
      // d.summaries: EodVariantSummary[] — trades that hit TP1+ and continue past midnight
      const summaries: EodVariantSummary[] = (d.summaries as EodVariantSummary[]) ?? []
      const dateStr = d.utcDate ?? ''
      if (summaries.every((s) => s.trades.length === 0)) {
        return `🌙 <b>EOD ${dateStr}</b>  · нет переходящих сделок`
      }
      const blocks = summaries.map((s) => {
        if (s.trades.length === 0) {
          return `<b>Вариант ${s.variant}</b>  · нет переходящих сделок`
        }
        const sign = (n: number) => `${n >= 0 ? '+' : ''}$${n.toFixed(2)}`
        const lines = s.trades.map((t) => {
          const sideEmoji = t.side === 'BUY' ? '🟢' : '🔴'
          const pnlR = `${t.pnlR >= 0 ? '+' : ''}${t.pnlR.toFixed(2)}R`
          return `   ${sideEmoji} ${t.symbol} → <b>${sign(t.pnlUsd)}</b>  (${pnlR}, реализовано)`
        }).join('\n')
        return [
          `<b>Вариант ${s.variant}</b>  · реализовано Σ <b>${sign(s.totalPnlUsd)}</b>`,
          lines,
        ].join('\n')
      }).join('\n\n')
      return [
        `🌙 <b>EOD ${dateStr}</b>  · сделки продолжают идти (TP1+)`,
        `━━━━━━━━━━━━━━━━━━`,
        blocks,
        ``,
        `<i>SL переведён в безубыток (или выше) — позиции остаются открытыми до SL/TP2/TP3</i>`,
      ].join('\n')
    }

    default:
      return `📋 ${action}: ${JSON.stringify(d)}`
  }
}

export async function sendNotification(action: OrderAction, details?: Record<string, any>): Promise<void> {
  try {
    if (!NOTIFY_ACTIONS.has(action)) return

    const config = await prisma.botConfig.findUnique({ where: { id: 1 } })

    if (!config || !config.telegramEnabled || !config.telegramBotToken || !config.telegramChatId) return

    const message = formatMessage(action, details)

    await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text: message,
        parse_mode: 'HTML',
      }),
    })

    console.log(`[Notifier] Sent ${action} notification`)
  } catch (err: any) {
    console.error('[Notifier] Failed to send:', err.message)
  }
}

export async function sendTestNotification(botToken: string, chatId: string): Promise<boolean> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '✅ Тестовое уведомление. Бот настроен и работает!',
        parse_mode: 'HTML',
      }),
    })

    const data = await response.json() as any
    return data.ok === true
  } catch (err: any) {
    console.error('[Notifier] Test failed:', err.message)
    return false
  }
}
