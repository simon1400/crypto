import { NewMessage, type NewMessageEvent } from 'telegram/events'
import { EditedMessage } from 'telegram/events/EditedMessage'
import { prisma } from '../db/prisma'
import { getTelegramClient } from '../services/telegram'
import { parseSignalMessage, extractCategory } from '../services/signalParser'
import { checkDailyLoss } from './dailyLossGuard'
import { executeSignalOrder } from './tradingService'
import { logOrderAction } from './orderLogger'

const EVENING_TRADER_PEER = 'EveningTrader'
const NEAR512_PEER = '-1002726338238'
const NEAR512_TOPIC_MAP: Record<number, string> = {
  6: 'Near512-LowCap',
  8: 'Near512-MidHigh',
  18: 'Near512-Spot',
}

let isListenerActive = false
let handlerRef: ((event: NewMessageEvent) => Promise<void>) | null = null
let editHandlerRef: ((event: NewMessageEvent) => Promise<void>) | null = null
let isDailyLimitPaused = false

/**
 * Handle an incoming Telegram message for auto-trading.
 * Exported for testability.
 */
export async function handleAutoMessage(event: NewMessageEvent): Promise<void> {
  try {
    const msg = event.message
    const text = msg.message
    const chatId = msg.chatId?.toString() ?? ''
    const messageId = msg.id
    const topicId = (msg as any).replyTo?.replyToMsgId as number | undefined
    const isEdit = !!(msg as any).editDate

    console.log(`[AutoListener] ${isEdit ? 'EDITED' : 'NEW'} msg #${messageId} chat=${chatId} topic=${topicId ?? '-'} text=${text?.substring(0, 80) ?? '(empty)'}`)

    // Determine channel name
    let channel: string | null = null
    if (chatId === NEAR512_PEER || chatId === `-${NEAR512_PEER.replace('-', '')}`) {
      // Near512 group - resolve topic
      if (topicId && NEAR512_TOPIC_MAP[topicId]) {
        channel = NEAR512_TOPIC_MAP[topicId]
      } else {
        return // Unknown topic in Near512 group
      }
    } else if (text) {
      channel = 'EveningTrader'
    } else {
      return
    }

    if (!channel) return

    if (!text) return
    const parsed: any = parseSignalMessage(text)

    if (!parsed) {
      console.log(`[AutoListener] Could not parse signal from msg #${messageId} (channel=${channel})`)
      return
    }
    console.log(`[AutoListener] Parsed: ${parsed.coin} ${parsed.type} lev=${parsed.leverage}x entry=${parsed.entryMin}-${parsed.entryMax} SL=${parsed.stopLoss} TPs=${parsed.takeProfits.join(',')}`)


    // Load BotConfig
    const config = await prisma.botConfig.findUnique({ where: { id: 1 } })
    if (!config || config.tradingMode !== 'auto') return

    // Channel/topic filter
    if (channel.startsWith('Near512')) {
      const enabledTopics = (config.near512Topics as string[]) || []
      if (!enabledTopics.includes(channel)) {
        await logOrderAction('AUTO_SKIPPED', {
          details: { channel, reason: 'topic_not_enabled' },
        })
        return
      }
    } else if (channel === 'EveningTrader') {
      const category = extractCategory(text)
      const enabledCategories = (config.eveningTraderCategories as string[]) || []
      if (category && enabledCategories.length > 0 && !enabledCategories.includes(category)) {
        await logOrderAction('AUTO_SKIPPED', {
          details: { channel, category, reason: 'category_not_enabled' },
        })
        return
      }
    }

    // Daily loss check
    if (isDailyLimitPaused) {
      const recheck = await checkDailyLoss()
      if (recheck.allowed) {
        isDailyLimitPaused = false
      } else {
        return
      }
    } else {
      const lossCheck = await checkDailyLoss()
      if (!lossCheck.allowed) {
        isDailyLimitPaused = true
        await logOrderAction('DAILY_LIMIT_HIT', {
          details: {
            realizedLossToday: lossCheck.realizedLossToday,
            prospectiveWorstCase: lossCheck.prospectiveWorstCase,
            totalWorstCase: lossCheck.totalWorstCase,
            limitAmount: lossCheck.limitAmount,
            reason: lossCheck.reason,
          },
        })
        return
      }
    }

    // Save signal to DB
    let signal: any
    try {
      signal = await prisma.signal.create({
        data: {
          channel,
          messageId,
          publishedAt: new Date(),
          type: parsed.type,
          coin: parsed.coin,
          leverage: parsed.leverage,
          entryMin: parsed.entryMin,
          entryMax: parsed.entryMax,
          stopLoss: parsed.stopLoss,
          takeProfits: parsed.takeProfits,
          category: parsed.category ?? null,
        },
      })
    } catch (err: any) {
      // Unique constraint violation (duplicate signal — already processed)
      if (err.code === 'P2002') {
        console.log(`[AutoListener] Duplicate signal skipped: ${parsed.coin} msg #${messageId} (already in DB)`)
        return
      }
      throw err
    }

    // Execute order
    await executeSignalOrder(signal.id)
    await logOrderAction('AUTO_EXECUTED', {
      signalId: signal.id,
      details: { channel, coin: parsed.coin, type: parsed.type },
    })
  } catch (err: any) {
    console.error('[AutoListener] Error:', err.message)
    await logOrderAction('ERROR', {
      details: { error: err.message, context: 'auto_listener' },
    }).catch(() => {})
  }
}

/**
 * Start the auto listener for Telegram signals.
 * Subscribes to EveningTrader and Near512 channels.
 */
export async function startAutoListener(): Promise<void> {
  if (isListenerActive) return

  const client = await getTelegramClient()
  const chats = [EVENING_TRADER_PEER, NEAR512_PEER]

  handlerRef = handleAutoMessage
  client.addEventHandler(handlerRef, new NewMessage({ chats }))

  editHandlerRef = handleAutoMessage
  client.addEventHandler(editHandlerRef, new EditedMessage({ chats }))

  isListenerActive = true
  console.log('[AutoListener] Started -- listening for new + edited signals')
}

/**
 * Stop the auto listener.
 */
export async function stopAutoListener(): Promise<void> {
  if (!isListenerActive) return

  const client = await getTelegramClient()
  const chats = [EVENING_TRADER_PEER, NEAR512_PEER]

  if (handlerRef) {
    client.removeEventHandler(handlerRef, new NewMessage({ chats }))
    handlerRef = null
  }
  if (editHandlerRef) {
    client.removeEventHandler(editHandlerRef, new EditedMessage({ chats }))
    editHandlerRef = null
  }

  isListenerActive = false
  console.log('[AutoListener] Stopped')
}

/**
 * Check if the auto listener is currently active.
 */
export function isAutoListenerActive(): boolean {
  return isListenerActive
}

/**
 * Reset internal state for testing purposes.
 */
export function _resetForTests(): void {
  isListenerActive = false
  handlerRef = null
  editHandlerRef = null
  isDailyLimitPaused = false
}
