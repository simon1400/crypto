/**
 * Default scan universe — monedas verified on Bybit linear perpetual (USDT).
 * Split by sector so edits remain readable. BTC/ETH исключены — они базовые,
 * используются только для detect market regime.
 */
export const SCAN_COINS = [
  // Layer 1 (23)
  'SOL', 'BNB', 'XRP', 'ADA', 'AVAX',
  'DOT', 'NEAR', 'SUI', 'SEI', 'TIA',
  'INJ', 'APT', 'ATOM', 'ALGO', 'HBAR',
  'ICP', 'FIL', 'VET', 'EGLD', 'KAS',
  'TON', 'TRX', 'XLM',
  // Memes (14)
  'DOGE', 'PEPE', 'WIF', 'FLOKI', 'BONK',
  'MEME', 'PEOPLE', 'ACT', 'PNUT', 'BOME',
  'MEW', 'NOT', 'BRETT', 'SPX',
  // AI & DePIN (10)
  'RENDER', 'GRT', 'TAO', 'AKT', 'AR',
  'AIOZ', 'IO', 'GLM', 'THETA', 'IOTX',
  // DeFi (16)
  'LINK', 'AAVE', 'CRV', 'LDO', 'PENDLE',
  'JUP', 'ONDO', 'RUNE', 'UNI', 'COMP',
  'SNX', 'SUSHI', 'CAKE', 'DYDX', 'GMX',
  'BANANA',
  // Infra & L2 (13)
  'ARB', 'OP', 'STRK', 'MANTA', 'BLAST',
  'IMX', 'ZK', 'METIS', 'CELO', 'ZRO',
  'W', 'ALT', 'MORPHO',
  // Gaming (12)
  'GALA', 'SAND', 'AXS', 'ENJ', 'PIXEL',
  'PORTAL', 'SUPER', 'YGG', 'BIGTIME', 'RONIN',
  'BEAM', 'GODS',
  // Mid-cap volatile (16)
  'STX', 'ENS', 'JASMY', 'CHZ', 'MASK',
  'TRB', 'ORDI', 'WLD', 'PYTH', 'JTO',
  'BLUR', 'ARKM', 'AEVO', 'ENA', 'ILV',
  'HNT',
]
