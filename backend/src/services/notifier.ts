import { prisma } from '../db/prisma'
import { computeSizing, getMaxLeverage } from './marginGuard'

export type OrderAction =
  | 'BREAKOUT_NEW'
  | 'BREAKOUT_TP1_HIT'
  | 'BREAKOUT_TP2_HIT'
  | 'BREAKOUT_TP3_HIT'
  | 'BREAKOUT_SL_HIT'
  | 'BREAKOUT_EXPIRED'

const NOTIFY_ACTIONS: Set<OrderAction> = new Set([
  'BREAKOUT_NEW',
  'BREAKOUT_TP1_HIT',
  'BREAKOUT_TP2_HIT',
  'BREAKOUT_TP3_HIT',
  'BREAKOUT_SL_HIT',
  'BREAKOUT_EXPIRED',
])

function formatMessage(action: OrderAction, details?: Record<string, any>): string {
  const d = details || {}

  switch (action) {
    case 'BREAKOUT_NEW': {
      const sideEmoji = d.side === 'BUY' ? '🟢' : '🔴'
      const sideText = d.side === 'BUY' ? 'LONG' : 'SHORT'
      const sym = d.symbol
      const dec = sym.includes('USDT') ? 2 : 5
      const tps: number[] = (d.tpLadder as number[] || []).slice(0, 3)
      const tpLines = tps.map((tp, i) => {
        const pct = d.entryPrice ? (((tp - d.entryPrice) / d.entryPrice) * 100 * (d.side === 'BUY' ? 1 : -1)).toFixed(2) : '?'
        const pctClose = i === 0 ? '50%' : i === 1 ? '30%' : '20%'
        return `   ├ TP${i + 1}  <code>${tp.toFixed(dec)}</code>  (+${pct}%)  [${pctClose}]`
      }).join('\n')
      const slPctVal = d.entryPrice ? (((d.stopLoss - d.entryPrice) / d.entryPrice) * 100 * (d.side === 'BUY' ? 1 : -1)).toFixed(2) : '?'

      let sizingBlock = ''
      if (typeof d.depositUsd === 'number' && typeof d.riskPctPerTrade === 'number' && d.depositUsd > 0) {
        const targetMarginPct = typeof d.targetMarginPct === 'number' ? d.targetMarginPct : 10
        const sizing = computeSizing({
          symbol: sym,
          deposit: d.depositUsd,
          riskPct: d.riskPctPerTrade,
          targetMarginPct,
          entry: d.entryPrice,
          sl: d.stopLoss,
        })
        if (sizing) {
          const maxLev = getMaxLeverage(sym)
          const lvNote = sizing.cappedByMaxLeverage ? ` (max ${maxLev}x)` : ''
          sizingBlock = [
            ``,
            `💰 Депо:    <code>$${d.depositUsd.toFixed(2)}</code>  · Риск ${d.riskPctPerTrade}% (<code>$${sizing.riskUsd.toFixed(2)}</code>)`,
            `📐 Размер   <code>$${sizing.positionSizeUsd.toFixed(2)}</code>  · ${sizing.positionUnits.toFixed(6)} ${sym.replace('USDT', '')}`,
            `🪙 Маржа    <code>$${sizing.marginUsd.toFixed(2)}</code>  (~${targetMarginPct}% депо)`,
            `⚡ Плечо    <code>${sizing.leverage.toFixed(1)}x</code>${lvNote}`,
          ].join('\n')
        }
      }

      return [
        `${sideEmoji} <b>${sym}</b> <b>${sideText}</b>  · 🚀 Daily Breakout`,
        `━━━━━━━━━━━━━━━━━━`,
        `📐 Range    <code>${(d.rangeLow as number).toFixed(dec)}</code> – <code>${(d.rangeHigh as number).toFixed(dec)}</code>`,
        `📍 Вход     <code>${(d.entryPrice as number).toFixed(dec)}</code>`,
        `🛑 SL       <code>${(d.stopLoss as number).toFixed(dec)}</code>  (${slPctVal}%)`,
        ``,
        `🎯 Тейки:`,
        tpLines,
        sizingBlock,
        ``,
        `<i>${d.reason ?? ''}</i>`,
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
      const isBE = d.realizedR >= 0
      const totalUsdLine = typeof d.realizedPnlUsd === 'number'
        ? `\n💵 Σ $    <b>${d.realizedPnlUsd >= 0 ? '+' : ''}$${d.realizedPnlUsd.toFixed(2)}</b>` : ''
      const depoLine = typeof d.depositUsd === 'number'
        ? `\n💼 Депо   <code>$${d.depositUsd.toFixed(2)}</code>` : ''
      return [
        `${isBE ? '🟡' : '🔴'} <b>${sym}</b>  ${d.reasonText ?? 'SL'}`,
        `━━━━━━━━━━━━━━━━━━`,
        `📍 Цена   <code>${(d.slPrice as number).toFixed(dec)}</code>`,
        `📊 Σ R    <b>${d.realizedR >= 0 ? '+' : ''}${(d.realizedR as number).toFixed(2)}R</b>${totalUsdLine}${depoLine}`,
      ].join('\n')
    }

    case 'BREAKOUT_EXPIRED': {
      const sym = d.symbol
      const totalUsdLine = typeof d.realizedPnlUsd === 'number'
        ? `\n💵 Σ $    ${d.realizedPnlUsd >= 0 ? '+' : ''}$${d.realizedPnlUsd.toFixed(2)}` : ''
      return [
        `⏱ <b>${sym}</b>  истёк (конец дня)`,
        `━━━━━━━━━━━━━━━━━━`,
        `📊 Σ R    <b>${d.realizedR >= 0 ? '+' : ''}${(d.realizedR as number).toFixed(2)}R</b>${totalUsdLine}`,
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
