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

function formatMessage(action: OrderAction, details?: Record<string, any>): string {
  const d = details || {}

  switch (action) {
    case 'ORDER_FILLED':
      return `🟢 <b>${d.type} ${d.symbol}</b> x${d.leverage} открыт по <code>$${d.entryPrice}</code>. Маржа: <code>$${d.margin}</code>`

    case 'TP1_HIT':
    case 'TP2_HIT':
    case 'TP3_HIT':
    case 'TP4_HIT':
    case 'TP5_HIT': {
      const n = action.replace('TP', '').replace('_HIT', '')
      return `✅ <b>${d.symbol}</b> TP${n} по <code>$${d.price}</code> (+${d.percent}%). P&L: <code>+$${d.pnl}</code>`
    }

    case 'SL_TRIGGERED':
      return `🔴 <b>${d.symbol}</b> SL по <code>$${d.price}</code>. P&L: <code>$${d.pnl}</code>`

    case 'POSITION_CLOSED':
      return `📊 <b>${d.symbol}</b> позиция закрыта. Итого P&L: <code>$${d.pnl}</code>`

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
