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
  limit = 50
): Promise<TelegramMessage[]> {
  const tg = await getTelegramClient()

  const result = await tg.invoke(
    new Api.messages.GetHistory({
      peer: channelUsername,
      limit,
      offsetId: 0,
      offsetDate: 0,
      addOffset: 0,
      maxId: 0,
      minId: 0,
      hash: BigInt(0) as any,
    })
  )

  if (!('messages' in result)) return []

  const messages: TelegramMessage[] = []
  for (const msg of result.messages) {
    if (msg instanceof Api.Message && msg.message) {
      messages.push({
        id: msg.id,
        date: msg.date,
        text: msg.message,
      })
    }
  }

  return messages
}

export function saveTelegramSession(sessionString: string) {
  saveSession(sessionString)
}
