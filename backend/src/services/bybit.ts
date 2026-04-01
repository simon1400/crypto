import { RestClientV5 } from 'bybit-api'
import { decrypt } from './encryption'
import { prisma } from '../db/prisma'

export async function createBybitClient(): Promise<RestClientV5> {
  const config = await prisma.botConfig.findUnique({ where: { id: 1 } })
  if (!config || !config.apiKey || !config.apiSecret) {
    throw new Error('Bybit API keys not configured')
  }

  const options: any = {
    key: decrypt(config.apiKey),
    secret: decrypt(config.apiSecret),
    testnet: config.useTestnet,
  }
  if (config.useTestnet) {
    options.baseUrl = 'https://api-testnet.bybit.eu'
  }
  return new RestClientV5(options)
}

export async function validateBybitKeys(
  apiKey: string,
  apiSecret: string,
  testnet: boolean
): Promise<{ valid: boolean; balance?: string; error?: string }> {
  try {
    const options: any = { key: apiKey, secret: apiSecret, testnet }
    if (testnet) {
      options.baseUrl = 'https://api-testnet.bybit.eu'
    }
    const client = new RestClientV5(options)
    const response = await client.getWalletBalance({ accountType: 'UNIFIED', coin: 'USDT' })

    if (response.retCode !== 0) {
      return { valid: false, error: response.retMsg }
    }

    const balance =
      response.result.list[0]?.coin?.find((c: any) => c.coin === 'USDT')?.walletBalance || '0'

    return { valid: true, balance }
  } catch (err: any) {
    return { valid: false, error: err.message || 'Connection failed' }
  }
}
