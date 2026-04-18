import Decimal from 'decimal.js'
import { prisma } from '../db/prisma'
import { createBybitClient } from '../services/bybit'
import { createOrderExecutor } from './orderExecutor'
import { getInstrumentInfo } from './instrumentCache'
import { logOrderAction } from './orderLogger'
import { resolveBybitSymbol } from './tickerMapper'
import { alignToTickSize } from './positionSizer'

interface ExecuteRealParams {
  generatedSignalId: number
  marginUsdt: number
  leverage: number
  orderType: 'market' | 'limit'
  entryPrice: number
  stopLoss: number
  lastTakeProfit: number
}

export interface RealOrderResult {
  positionId: number
  symbol: string
  qty: string
  entryOrderId: string
  bybitOrderType: 'Market' | 'Limit'
  alignedEntryPrice?: string
  alignedStopLoss: string
  alignedTakeProfit: string
}

/**
 * Place a real Bybit order for a scanner-generated signal.
 *
 * Differs from executeSignalOrder() (which works on Telegram-sourced Signal):
 * - Uses GeneratedSignal as source
 * - User-provided margin/leverage (not config.positionSizePct)
 * - Only places the LAST (furthest) TP — user adds intermediate TPs manually
 * - Always uses the user-chosen orderType (market/limit), no auto-detection
 *
 * Creates a Position record so trailing/reconcile machinery still tracks it.
 */
export async function executeRealOrderForGenSignal(
  params: ExecuteRealParams
): Promise<RealOrderResult> {
  const {
    generatedSignalId, marginUsdt, leverage, orderType,
    entryPrice, stopLoss, lastTakeProfit,
  } = params

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
    const adjLastTp = mult === 1 ? lastTakeProfit : new Decimal(lastTakeProfit).times(mult).toNumber()

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

    // Place last TP as reduceOnly limit
    const closeSide: 'Buy' | 'Sell' = isLong ? 'Sell' : 'Buy'
    const tpDir: 'floor' | 'ceil' = closeSide === 'Sell' ? 'ceil' : 'floor'
    const alignedTp = alignToTickSize(adjLastTp, instrument.tickSize, tpDir)

    let tpOrderId: string | null = null
    try {
      const tpResp = await client.submitOrder({
        category: 'linear',
        symbol,
        side: closeSide,
        orderType: 'Limit',
        qty,
        price: alignedTp,
        timeInForce: 'GTC',
        positionIdx: 0,
        reduceOnly: true,
        orderLinkId: `${orderLinkPrefix}-tp-last`,
      })
      if (tpResp.retCode !== 0) {
        console.warn(`[RealOrderGen] TP order failed: ${tpResp.retMsg}`)
      } else {
        tpOrderId = tpResp.result.orderId
      }
    } catch (err: any) {
      console.warn(`[RealOrderGen] TP order exception: ${err.message}`)
    }

    // Calculate margin actually used
    const fillPrice = bybitOrderType === 'Market' ? currentPrice : adjEntry
    const actualMargin = (parseFloat(qty) * fillPrice) / leverage

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
        takeProfits: [parseFloat(alignedTp)],
        tpOrderIds: tpOrderId ? [tpOrderId] : [],
        status: bybitOrderType === 'Market' ? 'OPEN' : 'PENDING_ENTRY',
        entryPrice: bybitOrderType === 'Market' ? fillPrice : null,
        filledAt: bybitOrderType === 'Market' ? new Date() : null,
        // signalId stays null — this Position is linked to GeneratedSignal, not Signal
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
        takeProfit: alignedTp,
        leverage,
        margin: actualMargin,
        entryOrderId,
        tpOrderId,
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
      alignedTakeProfit: alignedTp,
    }
  })
}
