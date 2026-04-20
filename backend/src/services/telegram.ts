import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { Api } from 'telegram'
import * as path from 'path'
import * as fs from 'fs'

const API_ID = Number(process.env.TELEGRAM_API_ID)
const API_HASH = process.env.TELEGRAM_API_HASH || ''
const SESSION_FILE = path.join(__dirname, '../../.telegram-session')

let client: TelegramClient | null = null
let healthCheckInterval: ReturnType<typeof setInterval> | null = null

function loadSession(): string {
  try {
    return fs.readFileSync(SESSION_FILE, 'utf-8').trim()
  } catch {
    return ''
  }
}

function saveSession(session: string) {
  fs.writeFileSync(SESSION_FILE, session, 'utf-8')
}

export async function getTelegramClient(): Promise<TelegramClient> {
  if (client && client.connected) return client

  const sessionStr = loadSession()
  const session = new StringSession(sessionStr)
  client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 10,
    autoReconnect: true,
  })

  if (!sessionStr) {
    throw new Error(
      'Telegram session not found. Run "npx tsx src/telegram-auth.ts" to authenticate first.'
    )
  }

  await client.connect()
  console.log('[Telegram] Client connected')

  // Start health check — ping every 5 minutes to detect silent disconnects
  startHealthCheck()

  return client
}

function startHealthCheck() {
  if (healthCheckInterval) return

  healthCheckInterval = setInterval(async () => {
    if (!client) return

    if (!client.connected) {
      console.warn('[Telegram] Health check: disconnected, reconnecting...')
      try {
        await client.connect()
        console.log('[Telegram] Health check: reconnected successfully')
      } catch (err: any) {
        console.error('[Telegram] Health check: reconnect failed:', err.message)
      }
      return
    }

    // Ping with a lightweight API call to detect silent connection loss
    try {
      await client.invoke(new Api.updates.GetState())
    } catch (err: any) {
      console.warn('[Telegram] Health check: getState failed, reconnecting...', err.message)
      try {
        await client.connect()
        console.log('[Telegram] Health check: reconnected after getState failure')
      } catch (reconnectErr: any) {
        console.error('[Telegram] Health check: reconnect failed:', reconnectErr.message)
      }
    }
  }, 5 * 60 * 1000) // every 5 minutes
}

export function stopHealthCheck() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval)
    healthCheckInterval = null
  }
}

export interface TelegramMessage {
  id: number
  date: number // unix timestamp
  text: string
  hasMedia?: boolean
  replyToMsgId?: number // id of the message this one replies to (for ETG status updates)
}

/**
 * Download media (photo) from a Telegram message.
 * Returns Buffer or null if no media.
 */
export async function downloadMessageMedia(
  channelUsername: string,
  messageId: number,
  topicId?: number
): Promise<Buffer | null> {
  const tg = await getTelegramClient()
  const peer = resolvePeer(channelUsername)

  try {
    let result: any

    if (topicId) {
      result = await tg.invoke(
        new Api.messages.GetReplies({
          peer,
          msgId: topicId,
          offsetId: messageId + 1,
          limit: 1,
          addOffset: 0,
          maxId: messageId + 1,
          minId: messageId - 1,
          hash: BigInt(0) as any,
        })
      )
    } else {
      result = await tg.invoke(
        new Api.channels.GetMessages({
          channel: peer as any,
          id: [new Api.InputMessageID({ id: messageId })],
        })
      )
    }

    if (!result?.messages?.[0]) return null
    const msg = result.messages[0]

    if (!(msg instanceof Api.Message) || !msg.media) return null

    const buffer = await tg.downloadMedia(msg, {}) as Buffer
    return buffer || null
  } catch (err: any) {
    console.error(`[Telegram] Failed to download media msg #${messageId}:`, err.message)
    return null
  }
}

function resolvePeer(channelUsername: string): string | number {
  if (/^-?\d+$/.test(channelUsername)) return Number(channelUsername)
  return channelUsername
}

export async function getChannelMessages(
  channelUsername: string,
  sinceTimestamp: number,
  topicId?: number
): Promise<TelegramMessage[]> {
  const tg = await getTelegramClient()
  const peer = resolvePeer(channelUsername)

  const allMessages: TelegramMessage[] = []
  let offsetId = 0
  const batchSize = 100
  let batchNum = 0

  while (true) {
    let result: any

    if (topicId) {
      // Forum topic — use GetReplies to fetch messages from specific topic
      result = await tg.invoke(
        new Api.messages.GetReplies({
          peer,
          msgId: topicId,
          offsetId,
          limit: batchSize,
          addOffset: 0,
          maxId: 0,
          minId: 0,
          hash: BigInt(0) as any,
        })
      )
    } else {
      result = await tg.invoke(
        new Api.messages.GetHistory({
          peer,
          limit: batchSize,
          offsetId,
          offsetDate: 0,
          addOffset: 0,
          maxId: 0,
          minId: 0,
          hash: BigInt(0) as any,
        })
      )
    }

    if (!('messages' in result) || result.messages.length === 0) break

    batchNum++
    let reachedOldest = false
    let lastDate = 0

    for (const msg of result.messages) {
      // Update offsetId for ALL message types (Message, MessageService, etc.)
      if ('id' in msg) offsetId = msg.id as number
      if ('date' in msg) lastDate = msg.date as number

      if (msg instanceof Api.Message) {
        if (msg.date < sinceTimestamp) {
          reachedOldest = true
          break
        }
        if (msg.message || msg.media) {
          const replyTo = (msg as any).replyTo
          const replyToMsgId = replyTo?.replyToMsgId as number | undefined
          allMessages.push({
            id: msg.id,
            date: msg.date,
            text: msg.message || '',
            hasMedia: !!msg.media,
            replyToMsgId: typeof replyToMsgId === 'number' ? replyToMsgId : undefined,
          })
        }
      }
    }

    console.log(`[Telegram] ${channelUsername}${topicId ? ':topic' + topicId : ''} batch ${batchNum}: ${result.messages.length} msgs, last date: ${new Date(lastDate * 1000).toISOString()}, total collected: ${allMessages.length}`)

    if (reachedOldest || result.messages.length < batchSize) break
  }

  console.log(`[Telegram] ${channelUsername}${topicId ? ':topic' + topicId : ''} done: ${allMessages.length} messages in ${batchNum} batches`)
  return allMessages
}

export function saveTelegramSession(sessionString: string) {
  saveSession(sessionString)
}
