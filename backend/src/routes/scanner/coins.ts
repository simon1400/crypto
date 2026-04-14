import { Router } from 'express'
import { SCAN_COINS } from '../../scanner/coinScanner'
import { prisma } from '../../db/prisma'
import { asyncHandler } from '../_helpers'

const router = Router()

// GET /api/scanner/coins — get selected coins for scanning (or default SCAN_COINS)
router.get('/coins', asyncHandler(async (_req, res) => {
  try {
    const config = await prisma.botConfig.findUnique({ where: { id: 1 } })
    const selected = (config?.scannerCoins as string[]) || []
    res.json({ coins: selected.length > 0 ? selected : SCAN_COINS })
  } catch {
    res.json({ coins: SCAN_COINS })
  }
}, 'Scanner'))

// GET /api/scanner/coin-list — get all Bybit + BingX USDT pairs + current selection
router.get('/coin-list', asyncHandler(async (_req, res) => {
  // Fetch Bybit and BingX contract lists in parallel
  const [bybitCoins, bingxCoins] = await Promise.all([
    fetchBybitCoins(),
    fetchBingxCoins(),
  ])

  const bybitSet = new Set(bybitCoins)
  // BingX-only = coins on BingX but NOT on Bybit (after dedup and filtering non-crypto)
  const bingxOnly = deduplicateBingxCoins(bingxCoins, bybitSet)

  // Combine: all Bybit coins + BingX-only coins
  const allCoins = [...bybitCoins, ...bingxOnly].sort()

  const config = await prisma.botConfig.findUnique({ where: { id: 1 } })
  const selected = (config?.scannerCoins as string[]) || []

  res.json({ available: allCoins, selected, bingxOnly })
}, 'Scanner'))

/**
 * Filter BingX coins to only those genuinely unique vs Bybit.
 * Removes: NC* (forex/stocks/commodities), known rename duplicates,
 * tokenized stocks, garbage memes, and low-quality tickers.
 */
function deduplicateBingxCoins(bingxCoins: string[], bybitSet: Set<string>): string[] {
  // Known BingX→Bybit rename mappings (same underlying asset, different ticker)
  const KNOWN_DUPES: Record<string, string> = {
    'SHIB': 'SHIB1000',
    'FLOKI': '1000FLOKI',
    'TURBO': '1000TURBO',
    'RATS': '1000RATS',
    'NEIROCTO': '1000NEIROCTO',
    'TOSHI': '1000TOSHI',
    'TAG': '1000TAG',
    'TONCOIN': 'TON',
    'LUNA': 'LUNA2',
    'ALTCOIN': 'ALT',
    'TRUMPSOL': 'TRUMP',
    'BROCCOLIF3B': 'BROCCOLI',
    'HYPERLANE': 'HYPER',
    'LAYER': 'SOLAYER',
    'FIGHTID': 'FIGHT',
    'SPACECOIN': 'SPACE',
    'EDGEX': 'EDGE',
    'RAY': 'RAYDIUM',
  }

  // Tokenized stocks/ETFs (end with X pattern or known tickers)
  const TOKENIZED_STOCKS = new Set([
    'AAPLX', 'NVDAX', 'METAX', 'CRCLX',
  ])

  // Garbage/joke meme tokens not worth scanning
  const BLACKLIST = new Set([
    'BUTTCOIN', 'TESTICLE', 'WHATTHEDOGDOING', 'WOTAMALAILE',
    'FIXIN1DAY', 'FREEDOMMONEY', 'COPPERINU', 'DISTORTED',
    'PIGEON', '1000000BOB', 'LONGXIA', 'XUEQIU', 'GOBOB',
  ])

  return bingxCoins.filter(coin => {
    if (bybitSet.has(coin)) return false
    if (KNOWN_DUPES[coin] && bybitSet.has(KNOWN_DUPES[coin])) return false
    if (coin.startsWith('NC')) return false
    if (coin.length === 1) return false
    if (TOKENIZED_STOCKS.has(coin)) return false
    if (BLACKLIST.has(coin)) return false
    return true
  })
}

async function fetchBybitCoins(): Promise<string[]> {
  try {
    const res = await fetch('https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000')
    const data = await res.json() as { result: { list: { symbol: string; status: string; quoteCoin: string }[] } }
    return data.result.list
      .filter(s => s.status === 'Trading' && s.quoteCoin === 'USDT')
      .map(s => s.symbol.replace('USDT', ''))
  } catch {
    return []
  }
}

async function fetchBingxCoins(): Promise<string[]> {
  try {
    const res = await fetch('https://open-api.bingx.com/openApi/swap/v2/quote/contracts')
    const data = await res.json() as { code: number; data?: { symbol: string; status: number | string; currency: string }[] }
    if (data.code !== 0 || !Array.isArray(data.data)) return []
    return data.data
      .filter(c => Number(c.status) === 1 && c.currency === 'USDT')
      .map(c => c.symbol.replace('-USDT', ''))
  } catch {
    return []
  }
}

// PUT /api/scanner/coin-list — save selected coins
router.put('/coin-list', asyncHandler(async (req, res) => {
  const { coins } = req.body as { coins: string[] }
  if (!Array.isArray(coins)) {
    res.status(400).json({ error: 'coins array required' })
    return
  }

  await prisma.botConfig.upsert({
    where: { id: 1 },
    create: { scannerCoins: coins },
    update: { scannerCoins: coins },
  })

  res.json({ saved: coins.length })
}, 'Scanner'))

export default router
