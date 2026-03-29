import 'dotenv/config'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { saveTelegramSession } from './services/telegram'
import * as readline from 'readline'

const API_ID = Number(process.env.TELEGRAM_API_ID)
const API_HASH = process.env.TELEGRAM_API_HASH || ''

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function main() {
  console.log('Telegram Authentication')
  console.log('=======================\n')

  const session = new StringSession('')
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
  })

  await client.start({
    phoneNumber: async () => await ask('Enter your phone number (with country code, e.g. +380...): '),
    password: async () => await ask('Enter your 2FA password (if set): '),
    phoneCode: async () => await ask('Enter the code you received: '),
    onError: (err) => console.error('Error:', err),
  })

  const sessionString = client.session.save() as unknown as string
  saveTelegramSession(sessionString)

  console.log('\nAuthentication successful! Session saved.')
  console.log('You can now start the backend server.\n')

  await client.disconnect()
  process.exit(0)
}

main().catch(err => {
  console.error('Auth failed:', err)
  process.exit(1)
})
