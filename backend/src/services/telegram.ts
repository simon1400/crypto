import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { Api } from 'telegram'
import * as path from 'path'
import * as fs from 'fs'

const API_ID = Number(process.env.TELEGRAM_API_ID)
const API_HASH = process.env.TELEGRAM_API_HASH || ''
const SESSION_FILE = path.join(__dirname, '../../.telegram-session')

let client: TelegramClient | null = null

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
    connectionRetries: 5,
  })

  if (!sessionStr) {
    // First-time auth — needs interactive input
    // Run: npx tsx src/telegram-auth.ts
    throw new Error(
      'Telegram session not found. Run "npx tsx src/telegram-auth.ts" to authenticate first.'
    )
  }

  await client.connect()
  return client
}

export interface TelegramMessage {
  id: number
  date: number // unix timestamp
  text: string
}

export async function getChannelMessages(
  channelUsername: string,
  sinceTimestamp: number
): Promise<TelegramMessage[]> {
  const tg = await getTelegramClient()

  const allMessages: TelegramMessage[] = []
  let offsetId = 0
  const batchSize = 100
  let batchNum = 0

  while (true) {
    const result = await tg.invoke(
      new Api.messages.GetHistory({
        peer: channelUsername,
        limit: batchSize,
        offsetId,
        offsetDate: 0,
        addOffset: 0,
        maxId: 0,
        minId: 0,
        hash: BigInt(0) as any,
      })
    )

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
        if (msg.message) {
          allMessages.push({
            id: msg.id,
            date: msg.date,
            text: msg.message,
          })
        }
      }
    }

    console.log(`[Telegram] ${channelUsername} batch ${batchNum}: ${result.messages.length} msgs, last date: ${new Date(lastDate * 1000).toISOString()}, total collected: ${allMessages.length}`)

    if (reachedOldest || result.messages.length < batchSize) break
  }

  console.log(`[Telegram] ${channelUsername} done: ${allMessages.length} messages in ${batchNum} batches`)
  return allMessages
}

export function saveTelegramSession(sessionString: string) {
  saveSession(sessionString)
}
