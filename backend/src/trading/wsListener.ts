import { WebsocketClient } from 'bybit-api'
import { prisma } from '../db/prisma'
import { decrypt } from '../services/encryption'
import { handleOrderUpdate, handlePositionUpdate, reconcilePositions } from './positionManager'

let wsClient: WebsocketClient | null = null

/**
 * Start WebSocket listener for real-time Bybit order/position events.
 *
 * Subscribes to order, execution, position, and wallet topics on linear.
 * Dispatches events to positionManager handlers.
 * If BotConfig has no API keys, logs warning and skips (doesn't crash server).
 */
export async function startWsListener(): Promise<void> {
  const config = await prisma.botConfig.findUnique({ where: { id: 1 } })
  if (!config || !config.apiKey || !config.apiSecret) {
    console.warn('[WsListener] No API keys configured, skipping WebSocket connection')
    return
  }

  const key = decrypt(config.apiKey)
  const secret = decrypt(config.apiSecret)

  wsClient = new WebsocketClient({
    key,
    secret,
    market: 'v5',
    testnet: config.useTestnet,
  })

  // Subscribe to private topics on linear
  wsClient.subscribeV5(['order', 'execution', 'position', 'wallet'], 'linear')

  wsClient.on('update', (data: any) => {
    try {
      const topic = data.topic as string

      if (topic === 'order') {
        handleOrderUpdate(data.data).catch((err) =>
          console.error('[WsListener] Order update error:', err.message)
        )
      } else if (topic === 'position') {
        handlePositionUpdate(data.data).catch((err) =>
          console.error('[WsListener] Position update error:', err.message)
        )
      }
      // execution and wallet events can be handled later if needed
    } catch (err: any) {
      console.error('[WsListener] Update dispatch error:', err.message)
    }
  })

  wsClient.on('open', ({ wsKey }: any) => {
    console.log(`[WsListener] Connected (wsKey: ${wsKey})`)
  })

  wsClient.on('reconnect', ({ wsKey }: any) => {
    console.log(`[WsListener] Reconnecting (wsKey: ${wsKey})`)
  })

  wsClient.on('reconnected', ({ wsKey }: any) => {
    console.log(`[WsListener] Reconnected (wsKey: ${wsKey}), running reconciliation...`)
    reconcilePositions().catch((err) =>
      console.error('[WsListener] Reconcile after reconnect error:', err.message)
    )
  })

  wsClient.on('response', (response: any) => {
    if (response.success === false) {
      console.error('[WsListener] Subscription error:', response.ret_msg)
    }
  })

  wsClient.on('exception', (err: any) => {
    console.error('[WsListener] Exception:', err.message || err)
  })

  console.log('[WsListener] WebSocket listener started')
}

/**
 * Stop WebSocket listener and close connection.
 */
export function stopWsListener(): void {
  if (wsClient) {
    wsClient.closeAll()
    wsClient = null
    console.log('[WsListener] WebSocket listener stopped')
  }
}
