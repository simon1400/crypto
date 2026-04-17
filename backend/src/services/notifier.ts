import { prisma } from '../db/prisma'
import { OrderAction } from '../trading/types'

const NOTIFY_ACTIONS: Set<OrderAction> = new Set([
  'ORDER_FILLED',
  'SL_TRIGGERED',
  'TP1_HIT',
  'TP2_HIT',
  'TP3_HIT',
  'TP4_HIT',
  'TP5_HIT',
  'POSITION_CLOSED',
  'KILL_SWITCH',
  'DAILY_LIMIT_HIT',
  'AUTO_SKIPPED',
  'MARKET_ENTRY',
  'ERROR',
])

function fmt(p: number | undefined): string {
  if (p == null) return '—'
  if (p === 0) return '0'
  if (Math.abs(p) >= 100) return p.toFixed(2)
  if (Math.abs(p) >= 1) return p.toFixed(2)
  return p.toPrecision(4)
}

function pnl(v: number | undefined): string {
  if (v == null) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`
}

function coin(symbol: string): string {
  return (symbol || '').replace(/USDT$/i, '')
}

function slPct(entry: number, sl: number, type: string): string {
  if (!entry || !sl) return ''
  const dir = type === 'LONG' ? -1 : 1
  const pct = ((sl - entry) / entry) * 100 * (type === 'LONG' ? 1 : -1)
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
}

function formatMessage(action: OrderAction, details?: Record<string, any>): string {
  const d = details || {}
  const ticker = coin(d.symbol)

  switch (action) {
    case 'ORDER_FILLED': {
      const tps = (d.takeProfits as any[] || [])
      const posSize = d.margin && d.leverage ? d.margin * d.leverage : null
      const slDist = slPct(d.entryPrice, d.stopLoss, d.type)
      const tpLines = tps.map((tp: any, i: number) => {
        const tpPct = d.entryPrice ? (((tp.price - d.entryPrice) / d.entryPrice) * 100 * (d.type === 'LONG' ? 1 : -1)).toFixed(1) : '?'
        return `   ├ TP${i + 1}  <code>${fmt(tp.price)}</code>  (+${tpPct}%)  [${tp.percent}%]`
      }).join('\n')

      return [
        `${d.type === 'LONG' ? '🟢' : '🔴'} <b>${ticker} ${d.type}</b>  ×${d.leverage}`,
        `━━━━━━━━━━━━━━━━━━`,
        `📍 Вход     <code>${fmt(d.entryPrice)}</code>`,
        `🛑 SL       <code>${fmt(d.stopLoss)}</code>  (${slDist})`,
        `💰 Маржа    <code>$${d.margin?.toFixed(2)}</code>`,
        posSize ? `📐 Позиция  <code>$${posSize.toFixed(2)}</code>` : '',
        ``,
        `🎯 Тейки:`,
        tpLines,
      ].filter(l => l !== '').join('\n')
    }

    case 'TP1_HIT':
    case 'TP2_HIT':
    case 'TP3_HIT':
    case 'TP4_HIT':
    case 'TP5_HIT': {
      const n = action.replace('TP', '').replace('_HIT', '')
      return [
        `✅ <b>${ticker}</b>  TP${n} сработал`,
        `━━━━━━━━━━━━━━━━━━`,
        `💲 Цена     <code>${fmt(d.price)}</code>  (+${d.pnlPct?.toFixed(1)}%)`,
        `📦 Закрыто  ${d.closedPct}%  →  <code>${pnl(d.pnl)}$</code>`,
        `📊 Итого    <code>${pnl(d.totalRealizedPnl)}$</code>`,
        `📉 Осталось ${d.remainingPct}%`,
        d.newStopLoss != null ? `🛑 SL → <code>${fmt(d.newStopLoss)}</code>` : '',
      ].filter(l => l !== '').join('\n')
    }

    case 'SL_TRIGGERED': {
      const tag = d.exitReason === 'BE_STOP' ? '🟡 BE' : d.exitReason === 'TRAILING_STOP' ? '🟡 Trail' : '🔴 SL'
      const emoji = d.totalRealizedPnl >= 0 ? '💚' : '💔'
      return [
        `${tag} <b>${ticker}</b>  стоп сработал`,
        `━━━━━━━━━━━━━━━━━━`,
        `💲 Цена     <code>${fmt(d.price)}</code>`,
        `📉 P&L      <code>${pnl(d.pnl)}$</code>  (${pnl(d.pnlPct)}%)`,
        `${emoji} Итого    <code>${pnl(d.totalRealizedPnl)}$</code>`,
        `💸 Комиссии <code>${d.totalFees?.toFixed(2) || '0'}$</code>`,
        d.timeInTrade ? `⏱ Время    ${d.timeInTrade}` : '',
      ].filter(l => l !== '').join('\n')
    }

    case 'POSITION_CLOSED': {
      const emoji = d.netPnl >= 0 ? '🏆' : '📉'
      return [
        `${emoji} <b>${ticker}</b>  позиция закрыта`,
        `━━━━━━━━━━━━━━━━━━`,
        `💰 P&L      <code>${pnl(d.totalRealizedPnl)}$</code>`,
        `💸 Комиссии <code>${d.totalFees?.toFixed(2) || '0'}$</code>`,
        `${d.netPnl >= 0 ? '💚' : '💔'} Нетто    <code>${pnl(d.netPnl)}$</code>`,
        d.timeInTrade ? `⏱ Время    ${d.timeInTrade}` : '',
      ].filter(l => l !== '').join('\n')
    }

    case 'KILL_SWITCH':
      return '🚨 <b>KILL SWITCH</b> активирован. Все ордера отменены'

    case 'DAILY_LIMIT_HIT':
      return '⚠️ Дневной лимит убытка достигнут. Авто-торговля приостановлена'

    case 'AUTO_SKIPPED':
      return `⏭️ <b>${d.coin}</b> пропущена — ${d.reason}`

    case 'MARKET_ENTRY':
      return `🟢 <b>${d.symbol}</b> ${d.type} вход по рынку (market entry)`

    case 'ERROR':
      return `❌ Ошибка: ${d.message}`

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
