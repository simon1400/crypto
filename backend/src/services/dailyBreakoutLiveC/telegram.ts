import { prisma } from '../../db/prisma'
import { LOG, TG_PREFIX } from './state'

/**
 * Telegram helper — sends a live notification using the BotConfig credentials.
 * Kept separate from notifier.ts (which is paper-only) so live events don't
 * risk regressing the existing message templates.
 */
export async function sendLiveTelegram(html: string): Promise<void> {
  try {
    const cfg = await prisma.botConfig.findUnique({ where: { id: 1 } })
    if (!cfg?.telegramEnabled) return
    if (!cfg.telegramBotToken || !cfg.telegramChatId) return
    await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.telegramChatId,
        text: TG_PREFIX + html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
  } catch (e: any) {
    console.warn(`${LOG} Telegram send failed: ${e.message}`)
  }
}
