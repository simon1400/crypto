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
  'FOREX_SIGNAL_NEW',
  // === Levels strategy live signals ===
  'LEVELS_NEW' as any,
  'LEVELS_TP1_HIT' as any,
  'LEVELS_TP2_HIT' as any,
  'LEVELS_TP3_HIT' as any,
  'LEVELS_SL_HIT' as any,
  'LEVELS_EXPIRED' as any,
  'LEVELS_DAILY_SUMMARY' as any,
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

    case 'FOREX_SIGNAL_NEW': {
      const instrument = String(d.instrument || '')
      const type = String(d.type || 'LONG') as 'LONG' | 'SHORT'
      const emoji = type === 'LONG' ? '🟢' : '🔴'
      const score = Number(d.score || 0)
      const entry = Number(d.entry || 0)
      const sl = Number(d.stopLoss || 0)
      const tps = (d.takeProfits as { price: number; rr: number }[]) || []
      const session = d.session ? String(d.session) : ''
      const reasons = (d.reasons as string[]) || []

      // Precision: FX pairs (EURUSD, GBPUSD) need 5 decimals; JPY pairs / XAU / indices 2-3
      const decimals = forexDecimals(instrument)
      const fx = (v: number) => v.toFixed(decimals)

      const stopDist = Math.abs(entry - sl)
      const tpLines = tps
        .map((tp, i) => `   ├ TP${i + 1}  <code>${fx(tp.price)}</code>  (R:R 1:${tp.rr})`)
        .join('\n')

      const sessionLine = session ? `🕐 Сессия: ${session}` : ''
      const reasonLine = reasons.length
        ? `\n📝 ${reasons.slice(0, 3).join(' · ')}`
        : ''

      return [
        `${emoji} <b>FOREX ${instrument} ${type}</b>  Score: ${score}`,
        `━━━━━━━━━━━━━━━━━━`,
        `📍 Вход     <code>${fx(entry)}</code>`,
        `🛑 SL       <code>${fx(sl)}</code>  (Δ ${fx(stopDist)})`,
        `🎯 Тейки:`,
        tpLines,
        sessionLine,
        reasonLine ? reasonLine.trim() : '',
        `\n→ Открой в MT5. Калькулятор лотов в приложении.`,
      ]
        .filter((l) => l !== '')
        .join('\n')
    }

    case 'LEVELS_NEW' as any: {
      const sideEmoji = d.side === 'BUY' ? '🟢' : '🔴'
      const sideText = d.side === 'BUY' ? 'LONG' : 'SHORT'
      const sym = d.symbol
      const dec = d.market === 'FOREX' ? forexDecimals(sym) : (sym.includes('USDT') ? 2 : 5)
      const tps: number[] = (d.tpLadder as number[] || []).slice(0, 3)
      const tpLines = tps.map((tp, i) => {
        const pct = d.entryPrice ? (((tp - d.entryPrice) / d.entryPrice) * 100 * (d.side === 'BUY' ? 1 : -1)).toFixed(2) : '?'
        const pctClose = i === 0 ? '50%' : i === 1 ? '30%' : '20%'
        return `   ├ TP${i + 1}  <code>${tp.toFixed(dec)}</code>  (+${pct}%)  [${pctClose}]`
      }).join('\n')
      const slPctVal = d.entryPrice ? (((d.stopLoss - d.entryPrice) / d.entryPrice) * 100 * (d.side === 'BUY' ? 1 : -1)).toFixed(2) : '?'
      const fiboTag = d.isFibo ? ' 🌀<i>Fibo</i>' : ''
      const eventTag = d.event === 'BREAKOUT_RETEST' ? '🚀 Pierce&Retest' : '🎯 Reaction'

      // Position sizing block — only if scanner provided deposit + riskPct
      let sizingBlock = ''
      if (typeof d.depositUsd === 'number' && typeof d.riskPctPerTrade === 'number' && d.depositUsd > 0) {
        const riskUsd = (d.depositUsd * d.riskPctPerTrade) / 100
        const slDist = Math.abs(d.entryPrice - d.stopLoss)
        const positionUnits = slDist > 0 ? riskUsd / slDist : 0
        const positionSizeUsd = d.entryPrice * positionUnits
        // Recommended leverage: positionSize / depositUsd, capped at 100x
        const leverage = positionSizeUsd > 0 && d.depositUsd > 0
          ? Math.min(100, Math.max(1, positionSizeUsd / d.depositUsd))
          : 1
        // Lot conversion for forex (1 lot = 100,000 units of base currency for FX, 100 oz for XAU)
        let lotsLine = ''
        if (d.market === 'FOREX') {
          const lotSize = /^XAU|^XAG/.test(sym) ? 100 : 100_000
          const lots = positionUnits / lotSize
          lotsLine = `\n📦 Лоты      <code>${lots.toFixed(3)}</code>  (1 лот = ${lotSize})`
        }
        sizingBlock = [
          ``,
          `💰 Депо:    <code>$${d.depositUsd.toFixed(2)}</code>  · Риск ${d.riskPctPerTrade}% (<code>$${riskUsd.toFixed(2)}</code>)`,
          `📐 Размер   <code>$${positionSizeUsd.toFixed(2)}</code>  · ${positionUnits.toFixed(d.market === 'CRYPTO' ? 6 : 2)} ${d.market === 'CRYPTO' ? sym.replace('USDT', '') : 'units'}${lotsLine}`,
          `⚡ Плечо    <code>${leverage.toFixed(1)}x</code>  (рекомендуемое для риска ${d.riskPctPerTrade}%)`,
        ].join('\n')
      }

      return [
        `${sideEmoji} <b>${sym}</b> <b>${sideText}</b>  · ${eventTag}${fiboTag}`,
        `━━━━━━━━━━━━━━━━━━`,
        `📐 Уровень  <code>${(d.level as number).toFixed(dec)}</code>  (${d.source})`,
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

    case 'LEVELS_TP1_HIT' as any:
    case 'LEVELS_TP2_HIT' as any:
    case 'LEVELS_TP3_HIT' as any: {
      const n = String(action).replace('LEVELS_TP', '').replace('_HIT', '')
      const sym = d.symbol
      const dec = sym.includes('USDT') ? 2 : 5
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

    case 'LEVELS_SL_HIT' as any: {
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

    case 'LEVELS_EXPIRED' as any: {
      const sym = d.symbol
      const totalUsdLine = typeof d.realizedPnlUsd === 'number'
        ? `\n💵 Σ $    ${d.realizedPnlUsd >= 0 ? '+' : ''}$${d.realizedPnlUsd.toFixed(2)}` : ''
      return [
        `⏱ <b>${sym}</b>  истёк`,
        `━━━━━━━━━━━━━━━━━━`,
        `📊 Σ R    <b>${d.realizedR >= 0 ? '+' : ''}${(d.realizedR as number).toFixed(2)}R</b>${totalUsdLine}`,
      ].join('\n')
    }

    case 'LEVELS_PENDING' as any: {
      const sideEmoji = d.side === 'BUY' ? '🟢' : '🔴'
      const sideText = d.side === 'BUY' ? 'LONG' : 'SHORT'
      const sym = d.symbol
      const dec = d.market === 'FOREX' ? forexDecimals(sym) : (sym.includes('USDT') ? 2 : 5)
      const tps: number[] = (d.tpLadder as number[] || []).slice(0, 3)
      const tpLines = tps.map((tp, i) => {
        const pct = d.entryPrice ? (((tp - d.entryPrice) / d.entryPrice) * 100 * (d.side === 'BUY' ? 1 : -1)).toFixed(2) : '?'
        const pctClose = i === 0 ? '50%' : i === 1 ? '30%' : '20%'
        return `   ├ TP${i + 1}  <code>${tp.toFixed(dec)}</code>  (+${pct}%)  [${pctClose}]`
      }).join('\n')
      const slPctVal = d.entryPrice ? (((d.stopLoss - d.entryPrice) / d.entryPrice) * 100 * (d.side === 'BUY' ? 1 : -1)).toFixed(2) : '?'
      const expiresStr = d.pendingExpiresAt ? new Date(d.pendingExpiresAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : ''

      let sizingBlock = ''
      if (typeof d.depositUsd === 'number' && typeof d.riskPctPerTrade === 'number' && d.depositUsd > 0) {
        const riskUsd = (d.depositUsd * d.riskPctPerTrade) / 100
        const slDist = Math.abs(d.entryPrice - d.stopLoss)
        const positionUnits = slDist > 0 ? riskUsd / slDist : 0
        const positionSizeUsd = d.entryPrice * positionUnits
        sizingBlock = [
          ``,
          `💰 Депо:    <code>$${d.depositUsd.toFixed(2)}</code>  · Риск ${d.riskPctPerTrade}% (<code>$${riskUsd.toFixed(2)}</code>)`,
          `📐 Размер   <code>$${positionSizeUsd.toFixed(2)}</code>`,
        ].join('\n')
      }
      return [
        `⏳ ${sideEmoji} <b>${sym}</b> <b>${sideText}</b>  · 📌 Лимит ждёт`,
        `━━━━━━━━━━━━━━━━━━`,
        `📐 Лимит    <code>${(d.entryPrice as number).toFixed(dec)}</code>  (${d.source})`,
        `🛑 SL       <code>${(d.stopLoss as number).toFixed(dec)}</code>  (${slPctVal}%)`,
        ``,
        `🎯 Тейки:`,
        tpLines,
        sizingBlock,
        ``,
        `⏰ Действителен до ${expiresStr}`,
      ].filter((l) => l !== '').join('\n')
    }

    case 'LEVELS_LIMIT_FILLED' as any: {
      const sym = d.symbol
      const dec = sym.includes('USDT') ? 2 : 5
      return [
        `🎯 <b>${sym}</b>  Лимит исполнен → активна`,
        `━━━━━━━━━━━━━━━━━━`,
        `📍 Вход   <code>${(d.entryPrice as number).toFixed(dec)}</code>`,
        `🛑 SL     <code>${(d.slPrice as number).toFixed(dec)}</code>`,
      ].join('\n')
    }

    case 'LEVELS_LIMIT_CANCELLED' as any: {
      const sym = d.symbol
      const dec = sym.includes('USDT') ? 2 : 5
      return [
        `❎ <b>${sym}</b>  Лимит отменён`,
        `━━━━━━━━━━━━━━━━━━`,
        `📐 Уровень <code>${(d.level as number).toFixed(dec)}</code>`,
        `<i>Цена не дотронулась за окно или импульс сломался.</i>`,
      ].join('\n')
    }

    case 'LEVELS_DAILY_SUMMARY' as any: {
      const date = (d.date as string) || new Date().toISOString().slice(0, 10)
      const opened = d.opened as number
      const closed = d.closed as number
      const wins = d.wins as number
      const losses = d.losses as number
      const totalR = d.totalR as number
      const totalUsd = d.totalUsd as number | undefined
      const startUsd = d.startUsd as number | undefined
      const endUsd = d.endUsd as number | undefined
      const peakUsd = d.peakUsd as number | undefined
      const symbolList = (d.bySymbol as Array<{ symbol: string; pnlR: number; pnlUsd: number; trades: number }>) ?? []
      const symLines = symbolList.length > 0
        ? '\n\n📈 По инструментам:\n' + symbolList.map(s =>
            `   ${s.symbol}: ${s.trades}тр · ${s.pnlR >= 0 ? '+' : ''}${s.pnlR.toFixed(2)}R${typeof s.pnlUsd === 'number' ? ` · ${s.pnlUsd >= 0 ? '+' : ''}$${s.pnlUsd.toFixed(2)}` : ''}`
          ).join('\n')
        : ''
      const usdBlock = typeof totalUsd === 'number' ? [
        ``,
        `💵 Net P&L    <b>${totalUsd >= 0 ? '+' : ''}$${totalUsd.toFixed(2)}</b>`,
        typeof startUsd === 'number' && typeof endUsd === 'number'
          ? `💼 Депо       <code>$${startUsd.toFixed(2)}</code> → <code>$${endUsd.toFixed(2)}</code>` : '',
        typeof peakUsd === 'number' ? `🏔 Peak       <code>$${peakUsd.toFixed(2)}</code>` : '',
      ].filter(l => l).join('\n') : ''
      return [
        `📊 <b>Итоги дня</b> · ${date}`,
        `━━━━━━━━━━━━━━━━━━`,
        `🆕 Открыто    ${opened}`,
        `🏁 Закрыто    ${closed}  (✅ ${wins} / ❌ ${losses})`,
        `📈 Σ R        <b>${totalR >= 0 ? '+' : ''}${totalR.toFixed(2)}R</b>`,
        usdBlock,
        symLines,
      ].filter((l) => l !== '').join('\n')
    }

    default:
      return `📋 ${action}: ${JSON.stringify(d)}`
  }
}

// Decimal precision for forex/indices pricing
function forexDecimals(instrument: string): number {
  if (/^US30|NAS100|SPX500|GER40|UK100/.test(instrument)) return 2
  if (/JPY/.test(instrument)) return 3
  if (/^XAU/.test(instrument)) return 2
  if (/^XAG/.test(instrument)) return 3
  return 5 // EURUSD etc.
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
