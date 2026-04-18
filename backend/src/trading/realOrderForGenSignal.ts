import Decimal from 'decimal.js'
import { prisma } from '../db/prisma'
import { createBybitClient } from '../services/bybit'
import { createOrderExecutor } from './orderExecutor'
import { getInstrumentInfo } from './instrumentCache'
import { logOrderAction } from './orderLogger'
import { resolveBybitSymbol } from './tickerMapper'
import { alignToTickSize } from './positionSizer'

interface TpLevel {
  price: number
  percent: number  // 0-100, qty share for this TP
}

interface ExecuteRealParams {
  generatedSignalId: number
  marginUsdt: number
  leverage: number
  orderType: 'market' | 'limit'
  entryPrice: number
  stopLoss: number
  takeProfits: TpLevel[]
}

export interface PlacedTp {
  price: string       // aligned tick-size
  qty: string         // filled qty for this level
  orderId: string | null
  percent: number
  error?: string
}

export interface RealOrderResult {
  positionId: number
  symbol: string
  qty: string
  entryOrderId: string
  bybitOrderType: 'Market' | 'Limit'
  alignedEntryPrice?: string
  alignedStopLoss: string
  takeProfits: PlacedTp[]
}

/**
 * Place a real Bybit order for a scanner-generated signal.
 *
 * - User-provided margin/leverage (not config.positionSizePct)
 * - Places ALL TP levels as independent reduceOnly limits with qty-percent distribution
 * - Always uses the user-chosen orderType (market/limit), no auto-detection
 * - Creates a Position record so trailing/reconcile machinery still tracks it
 */
export async function executeRealOrderForGenSignal(
  params: ExecuteRealParams
): Promise<RealOrderResult> {
  const {
    generatedSignalId, marginUsdt, leverage, orderType,
    entryPrice, stopLoss, takeProfits: inputTps,
  } = params

  if (!inputTps || inputTps.length === 0) {
    throw new Error('Не передано ни одного take profit')
  }

  const signal = await prisma.generatedSignal.findUnique({
    where: { id: generatedSignalId },
  })
  if (!signal) throw new Error(`GeneratedSignal ${generatedSignalId} not found`)

  const config = await prisma.botConfig.findUnique({ where: { id: 1 } })
  if (!config) throw new Error('BotConfig not found')
  if (!config.apiKey || !config.apiSecret) {
    throw new Error('Bybit API keys not configured')
  }
  if (config.useTestnet) {
    throw new Error('Bybit подключен к testnet — реальная сделка возможна только на mainnet')
  }

  const client = await createBybitClient()
  const executor = createOrderExecutor(client)

  return executor.executeInQueue(async () => {
    // Resolve symbol (e.g. PEPE -> 1000PEPEUSDT)
    const baseCoin = signal.coin.toUpperCase().replace(/USDT$/, '')
    const resolution = await resolveBybitSymbol(baseCoin)
    if (!resolution) {
      throw new Error(`Symbol ${baseCoin}USDT не найден на Bybit`)
    }
    const symbol = resolution.bybitSymbol
    const mult = resolution.priceMultiplier

    // Apply price multiplier if needed
    const adjEntry = mult === 1 ? entryPrice : new Decimal(entryPrice).times(mult).toNumber()
    const adjStopLoss = mult === 1 ? stopLoss : new Decimal(stopLoss).times(mult).toNumber()

    // Default percent distribution by TP count
    const defaultPercents: Record<number, number[]> = {
      1: [100],
      2: [50, 50],
      3: [40, 30, 30],
      4: [30, 25, 25, 20],
    }
    const tpCount = inputTps.length
    const fallbackPcts = defaultPercents[tpCount] || Array(tpCount).fill(Math.floor(100 / tpCount))
    const adjTps = inputTps.map((tp, i) => ({
      price: mult === 1 ? tp.price : new Decimal(tp.price).times(mult).toNumber(),
      percent: tp.percent > 0 ? tp.percent : fallbackPcts[i],
    }))

    const instrument = await getInstrumentInfo(client, symbol)

    // Set leverage
    await executor.setLeverage(symbol, leverage)

    // Validate SL vs current price
    const tickerResp = await client.getTickers({ category: 'linear', symbol })
    const currentPrice = parseFloat((tickerResp.result as any).list[0].lastPrice)

    const isLong = signal.type === 'LONG'
    if (isLong && adjStopLoss >= currentPrice) {
      throw new Error(`SL ${adjStopLoss} >= текущая цена ${currentPrice} для LONG`)
    }
    if (!isLong && adjStopLoss <= currentPrice) {
      throw new Error(`SL ${adjStopLoss} <= текущая цена ${currentPrice} для SHORT`)
    }

    // For market orders use current price for sizing; for limit use the signal entry
    const sizingPrice = orderType === 'market' ? currentPrice : adjEntry
    const notional = new Decimal(marginUsdt).times(leverage)
    const qtyRaw = notional.div(sizingPrice)
    const step = new Decimal(instrument.qtyStep)
    const qtyDecimal = qtyRaw.div(step).floor().times(step)

    if (qtyDecimal.lt(new Decimal(instrument.minOrderQty))) {
      throw new Error(
        `Размер позиции ${qtyDecimal.toString()} < минимума ${instrument.minOrderQty} (${symbol})`
      )
    }
    const qty = qtyDecimal.toString()

    const side: 'Buy' | 'Sell' = isLong ? 'Buy' : 'Sell'
    const bybitOrderType: 'Market' | 'Limit' = orderType === 'market' ? 'Market' : 'Limit'

    const slDirection: 'floor' | 'ceil' = side === 'Buy' ? 'floor' : 'ceil'
    const alignedSl = alignToTickSize(adjStopLoss, instrument.tickSize, slDirection)

    let alignedEntry: string | undefined
    if (bybitOrderType === 'Limit') {
      // For LONG limit buy below: floor; SHORT limit sell above: ceil
      const dir: 'floor' | 'ceil' = side === 'Buy' ? 'floor' : 'ceil'
      alignedEntry = alignToTickSize(adjEntry, instrument.tickSize, dir)
    }

    const orderLinkPrefix = `gen-${signal.id}`

    const entryOrderParams: any = {
      category: 'linear',
      symbol,
      side,
      orderType: bybitOrderType,
      qty,
      timeInForce: bybitOrderType === 'Market' ? 'IOC' : 'GTC',
      positionIdx: 0,
      stopLoss: alignedSl,
      tpslMode: 'Full',
      orderLinkId: `${orderLinkPrefix}-entry`,
    }
    if (bybitOrderType === 'Limit' && alignedEntry) {
      entryOrderParams.price = alignedEntry
    }

    const entryResp = await client.submitOrder(entryOrderParams)
    if (entryResp.retCode !== 0) {
      throw new Error(`Bybit entry order failed: ${entryResp.retMsg}`)
    }
    const entryOrderId = entryResp.result.orderId
    const entryOrderLinkId = entryResp.result.orderLinkId

    // Place all TP levels as independent reduceOnly limits with qty distribution
    const closeSide: 'Buy' | 'Sell' = isLong ? 'Sell' : 'Buy'
    const tpDir: 'floor' | 'ceil' = closeSide === 'Sell' ? 'ceil' : 'floor'

    const qtyStep = new Decimal(instrument.qtyStep)
    const totalQty = qtyDecimal
    const placedTps: PlacedTp[] = []

    // Compute qty per TP, floor to qtyStep; remainder goes to the LAST TP so total matches
    const tpQtys: Decimal[] = adjTps.map((tp, i) => {
      if (i === adjTps.length - 1) return new Decimal(0) // placeholder — filled below
      const share = totalQty.times(tp.percent).div(100)
      return share.div(qtyStep).floor().times(qtyStep)
    })
    const sumBeforeLast = tpQtys.slice(0, -1).reduce((acc, v) => acc.plus(v), new Decimal(0))
    tpQtys[tpQtys.length - 1] = totalQty.minus(sumBeforeLast)

    const minQty = new Decimal(instrument.minOrderQty)

    for (let i = 0; i < adjTps.length; i++) {
      const tp = adjTps[i]
      const levelQty = tpQtys[i]
      const alignedTpPrice = alignToTickSize(tp.price, instrument.tickSize, tpDir)

      if (levelQty.lt(minQty)) {
        placedTps.push({
          price: alignedTpPrice,
          qty: levelQty.toString(),
          orderId: null,
          percent: tp.percent,
          error: `qty ${levelQty.toString()} < min ${instrument.minOrderQty}`,
        })
        console.warn(`[RealOrderGen] TP${i + 1} skipped: qty below min`)
        continue
      }

      try {
        const tpResp = await client.submitOrder({
          category: 'linear',
          symbol,
          side: closeSide,
          orderType: 'Limit',
          qty: levelQty.toString(),
          price: alignedTpPrice,
          timeInForce: 'GTC',
          positionIdx: 0,
          reduceOnly: true,
          orderLinkId: `${orderLinkPrefix}-tp${i + 1}`,
        })
        if (tpResp.retCode !== 0) {
          placedTps.push({
            price: alignedTpPrice,
            qty: levelQty.toString(),
            orderId: null,
            percent: tp.percent,
            error: tpResp.retMsg,
          })
          console.warn(`[RealOrderGen] TP${i + 1} failed: ${tpResp.retMsg}`)
        } else {
          placedTps.push({
            price: alignedTpPrice,
            qty: levelQty.toString(),
            orderId: tpResp.result.orderId,
            percent: tp.percent,
          })
        }
      } catch (err: any) {
        placedTps.push({
          price: alignedTpPrice,
          qty: levelQty.toString(),
          orderId: null,
          percent: tp.percent,
          error: err?.message || 'exception',
        })
        console.warn(`[RealOrderGen] TP${i + 1} exception: ${err.message}`)
      }
    }

    // Calculate margin actually used
    const fillPrice = bybitOrderType === 'Market' ? currentPrice : adjEntry
    const actualMargin = (parseFloat(qty) * fillPrice) / leverage

    const tpOrderIds = placedTps.map(t => t.orderId).filter((x): x is string => !!x)
    const tpPricesForDb = placedTps.map(t => parseFloat(t.price))

    const position = await prisma.position.create({
      data: {
        symbol,
        type: signal.type,
        leverage,
        qty: parseFloat(qty),
        margin: actualMargin,
        entryOrderId,
        entryOrderLinkId,
        stopLoss: parseFloat(alignedSl),
        takeProfits: tpPricesForDb,
        tpOrderIds,
        status: bybitOrderType === 'Market' ? 'OPEN' : 'PENDING_ENTRY',
        entryPrice: bybitOrderType === 'Market' ? fillPrice : null,
        filledAt: bybitOrderType === 'Market' ? new Date() : null,
      },
    })

    await logOrderAction('ORDER_PLACED', {
      positionId: position.id,
      details: {
        source: 'GENERATED_SIGNAL',
        generatedSignalId: signal.id,
        symbol,
        side,
        orderType: bybitOrderType,
        qty,
        price: alignedEntry || 'market',
        stopLoss: alignedSl,
        takeProfits: placedTps.map(t => ({ price: t.price, qty: t.qty, percent: t.percent, ok: !!t.orderId })),
        leverage,
        margin: actualMargin,
        entryOrderId,
      },
    })

    return {
      positionId: position.id,
      symbol,
      qty,
      entryOrderId,
      bybitOrderType,
      alignedEntryPrice: alignedEntry,
      alignedStopLoss: alignedSl,
      takeProfits: placedTps,
    }
  })
}
