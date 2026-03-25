// Top 3 publicly known active whale wallets (Ethereum)
const TOP_WHALES = [
  {
    address: '0x176F3DAb24a159341c0509bB36B833E7fdd0a132',
    name: 'Justin Sun',
    description: 'Tron founder, активный on-chain трейдер',
  },
  {
    address: '0x56178a0d5F301bAf6CF3e1Cd53d9863437345Bf9',
    name: 'James Fickel',
    description: 'Известный ETH-кит, крупные DeFi позиции',
  },
  {
    address: '0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549',
    name: 'Whale Fund',
    description: 'Крупный институциональный кошелёк, 21k+ ETH',
  },
]

export interface TokenTransfer {
  hash: string
  from: string
  to: string
  tokenName: string
  tokenSymbol: string
  tokenDecimal: number
  value: string
  valueFormatted: number
  timestamp: number
  direction: 'IN' | 'OUT'
}

export interface WhaleData {
  address: string
  name: string
  description: string
  ethBalance: number
  transfers: TokenTransfer[]
  summary: {
    totalBuys: number
    totalSells: number
    topTokens: { symbol: string; name: string; netAmount: number; direction: 'BUY' | 'SELL' }[]
  }
}

// Etherscan V2 API
const ETHERSCAN_BASE = 'https://api.etherscan.io/v2/api'

function getApiKey(): string {
  return process.env.ETHERSCAN_API_KEY || ''
}

async function fetchEthBalance(address: string): Promise<number> {
  const key = getApiKey()
  const url = `${ETHERSCAN_BASE}?chainid=1&module=account&action=balance&address=${address}&tag=latest&apikey=${key}`
  try {
    const res = await fetch(url)
    const data: any = await res.json()
    if (data.status === '1') {
      return parseFloat((Number(data.result) / 1e18).toFixed(4))
    }
  } catch (e) {
    console.warn(`Failed to fetch ETH balance for ${address}`)
  }
  return 0
}

async function fetchTokenTransfers(address: string): Promise<TokenTransfer[]> {
  const key = getApiKey()
  // Last 3 weeks
  const threeWeeksAgo = Math.floor((Date.now() - 21 * 24 * 60 * 60 * 1000) / 1000)

  const url = `${ETHERSCAN_BASE}?chainid=1&module=account&action=tokentx&address=${address}&page=1&offset=200&sort=desc&apikey=${key}`

  try {
    const res = await fetch(url)
    const data: any = await res.json()

    if (data.status !== '1' || !Array.isArray(data.result)) {
      return []
    }

    const addrLower = address.toLowerCase()

    return data.result
      .filter((tx: any) => {
        const ts = Number(tx.timeStamp)
        if (ts < threeWeeksAgo) return false

        // Only show transactions initiated BY the whale (not spam sent to them)
        // If whale is sender → they initiated it (OUT)
        // If whale is receiver → check if tx.from is a known contract/DEX (not random spam)
        // Simple heuristic: only include if whale is the "from" address
        // OR if the transfer is from a well-known DEX router / known contract
        const fromWhale = tx.from.toLowerCase() === addrLower
        const toWhale = tx.to.toLowerCase() === addrLower

        if (fromWhale) return true

        // For incoming: filter out spam by checking if it looks legit
        if (toWhale) {
          const symbol = tx.tokenSymbol || ''
          // Skip non-ASCII symbols
          if (/[^\x20-\x7E]/.test(symbol)) return false
          // Skip symbols longer than 10 chars (usually spam)
          if (symbol.length > 10) return false
          // Skip zero-value transfers
          if (tx.value === '0') return false
          // Keep known legit tokens
          const knownTokens = ['USDT', 'USDC', 'DAI', 'WETH', 'WBTC', 'LINK', 'UNI', 'AAVE', 'MKR', 'SNX', 'COMP', 'CRV', 'LDO', 'RPL', 'SUSHI', 'YFI', 'BAL', 'INCH', 'GRT', 'ENS', 'DYDX', 'FXS', 'FRAX', 'LUSD', 'RSR', 'PAXG', 'PEPE', 'SHIB', 'ARB', 'OP', 'MATIC', 'stETH', 'rETH', 'cbETH', 'PENDLE', 'ENA', 'ETHFI', 'EIGEN', 'DUSK', 'ILV', 'GHST', 'TUSD']
          if (knownTokens.includes(symbol)) return true
          // Otherwise skip (likely airdrop spam)
          return false
        }

        return false
      })
      .map((tx: any) => {
        const decimal = Number(tx.tokenDecimal) || 18
        const rawValue = Number(tx.value) / Math.pow(10, decimal)
        const direction = tx.to.toLowerCase() === addrLower ? 'IN' : 'OUT'

        return {
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          tokenName: tx.tokenName,
          tokenSymbol: tx.tokenSymbol,
          tokenDecimal: decimal,
          value: tx.value,
          valueFormatted: parseFloat(rawValue.toFixed(4)),
          timestamp: Number(tx.timeStamp),
          direction,
        } as TokenTransfer
      })
  } catch (e) {
    console.warn(`Failed to fetch token transfers for ${address}:`, e)
    return []
  }
}

function buildSummary(transfers: TokenTransfer[]) {
  const buys = transfers.filter((t) => t.direction === 'IN')
  const sells = transfers.filter((t) => t.direction === 'OUT')

  const tokenMap = new Map<string, { symbol: string; name: string; inAmount: number; outAmount: number }>()

  for (const t of transfers) {
    const key = t.tokenSymbol
    const existing = tokenMap.get(key) || { symbol: t.tokenSymbol, name: t.tokenName, inAmount: 0, outAmount: 0 }
    if (t.direction === 'IN') {
      existing.inAmount += t.valueFormatted
    } else {
      existing.outAmount += t.valueFormatted
    }
    tokenMap.set(key, existing)
  }

  const topTokens = Array.from(tokenMap.values())
    .map((t) => {
      const net = t.inAmount - t.outAmount
      return {
        symbol: t.symbol,
        name: t.name,
        netAmount: parseFloat(Math.abs(net).toFixed(4)),
        direction: (net >= 0 ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
      }
    })
    .sort((a, b) => b.netAmount - a.netAmount)
    .slice(0, 10)

  return {
    totalBuys: buys.length,
    totalSells: sells.length,
    topTokens,
  }
}

export async function fetchWhaleData(): Promise<WhaleData[]> {
  const results: WhaleData[] = []

  for (const whale of TOP_WHALES) {
    if (results.length > 0) {
      await new Promise((r) => setTimeout(r, 250))
    }

    const [ethBalance, transfers] = await Promise.all([
      fetchEthBalance(whale.address),
      fetchTokenTransfers(whale.address),
    ])

    results.push({
      address: whale.address,
      name: whale.name,
      description: whale.description,
      ethBalance,
      transfers,
      summary: buildSummary(transfers),
    })
  }

  return results
}

export function getWhaleList() {
  return TOP_WHALES
}
