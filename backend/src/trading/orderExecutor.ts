import PQueue from 'p-queue'
import Decimal from 'decimal.js'
import { RestClientV5 } from 'bybit-api'
import { logOrderAction } from './orderLogger'
import { alignToTickSize } from './positionSizer'

interface EntryTypeResult {
  orderType: 'Market' | 'Limit'
  price?: string
}

interface PlaceEntryParams {
  symbol: string
  side: 'Buy' | 'Sell'
  orderType: 'Market' | 'Limit'
  qty: string
  price?: string
  stopLoss: number
  signalId: number
  tickSize: string
}

interface PlaceTpParams {
  symbol: string
  side: 'Buy' | 'Sell'
  totalQty: string
  takeProfits: number[]
  signalId: number
  qtyStep: string
  tickSize: string
}

interface SignalForEntry {
  type: string
  entryMin: number
  entryMax: number
  category?: string | null
}

export class OrderExecutor {
  private queue: PQueue
  private client: RestClientV5

  constructor(client: RestClientV5) {
    this.client = client
    this.queue = new PQueue({ concurrency: 1 })
  }

  /**
   * Execute any async function through the serial queue.
   * All order operations should go through this to prevent race conditions.
   */
  async executeInQueue<T>(fn: () => Promise<T>): Promise<T> {
    return this.queue.add(fn) as Promise<T>
  }

  /**
   * Set leverage for a symbol. Handles error 110043 ("not modified") gracefully.
   */
  async setLeverage(symbol: string, leverage: number): Promise<void> {
    const response = await this.client.setLeverage({
      category: 'linear',
      symbol,
      buyLeverage: String(leverage),
      sellLeverage: String(leverage),
    })

    // retCode 0 = success, 110043 = leverage not modified (already set)
    if (response.retCode !== 0 && response.retCode !== 110043) {
      throw new Error(
        `Failed to set leverage for ${symbol}: ${response.retMsg}`
      )
    }
  }

  /**
   * Determine whether to use Market or Limit order based on current price and signal type.
   * - Scalp/Risk Scalp signals always use Market (D-02)
   * - If current price is within entryMin-entryMax -> Market (D-01)
   * - LONG outside range -> Limit at entryMax
   * - SHORT outside range -> Limit at entryMin
   */
  async determineEntryType(
    signal: SignalForEntry,
    symbol: string
  ): Promise<EntryTypeResult> {
    // Scalp signals always use market order for fast entry (D-02)
    if (
      signal.category === 'Scalp' ||
      signal.category === 'Risk Scalp'
    ) {
      return { orderType: 'Market' }
    }

    // Fetch current price
    const tickerResponse = await this.client.getTickers({
      category: 'linear',
      symbol,
    })

    const lastPrice = parseFloat(
      (tickerResponse.result as any).list[0].lastPrice
    )

    // Price within entry range -> Market order
    if (lastPrice >= signal.entryMin && lastPrice <= signal.entryMax) {
      return { orderType: 'Market' }
    }

    // LONG outside range -> Limit at entryMax (buy at upper edge)
    if (signal.type === 'LONG') {
      return {
        orderType: 'Limit',
        price: alignToTickSize(signal.entryMax, '0.01', 'floor'),
      }
    }

    // SHORT outside range -> Limit at entryMin (sell at lower edge)
    return {
      orderType: 'Limit',
      price: alignToTickSize(signal.entryMin, '0.01', 'ceil'),
    }
  }

  /**
   * Place entry order with SL attached using tpslMode Full (D-04).
   */
  async placeEntryWithSl(params: PlaceEntryParams): Promise<{
    orderId: string
    orderLinkId: string
  }> {
    const { symbol, side, orderType, qty, price, stopLoss, signalId, tickSize } = params

    // Align SL price: floor for Buy (SL below), ceil for Sell (SL above)
    const slDirection = side === 'Buy' ? 'floor' : 'ceil'
    const alignedSl = alignToTickSize(stopLoss, tickSize, slDirection)

    const orderParams: any = {
      category: 'linear',
      symbol,
      side,
      orderType,
      qty,
      timeInForce: orderType === 'Market' ? 'IOC' : 'GTC',
      positionIdx: 0,
      stopLoss: alignedSl,
      tpslMode: 'Full',
      orderLinkId: `sig-${signalId}-entry`,
    }

    // Include price only for Limit orders
    if (orderType === 'Limit' && price) {
      orderParams.price = price
    }

    const response = await this.client.submitOrder(orderParams)

    if (response.retCode !== 0) {
      throw new Error(
        `Failed to place entry order for ${symbol}: ${response.retMsg}`
      )
    }

    const result = {
      orderId: response.result.orderId,
      orderLinkId: response.result.orderLinkId,
    }

    await logOrderAction('ORDER_PLACED', {
      signalId,
      details: {
        symbol,
        side,
        orderType,
        qty,
        price: price || 'market',
        stopLoss: alignedSl,
        orderId: result.orderId,
        orderLinkId: result.orderLinkId,
      },
    })

    return result
  }

  /**
   * Place TP orders as independent reduceOnly limit orders (D-06, D-07).
   * Volume distributed equally across TP levels using Decimal (D-08).
   */
  async placeTpOrders(params: PlaceTpParams): Promise<string[]> {
    const { symbol, side, totalQty, takeProfits, signalId, qtyStep, tickSize } = params

    const total = new Decimal(totalQty)
    const step = new Decimal(qtyStep)
    const tpCount = takeProfits.length
    const orderIds: string[] = []

    // Calculate equal qty per TP level, floored to qtyStep
    const perTp = total.div(tpCount).div(step).floor().times(step)

    for (let i = 0; i < tpCount; i++) {
      // Last TP gets the remainder to ensure total matches
      const isLast = i === tpCount - 1
      const qty = isLast
        ? total.minus(perTp.times(tpCount - 1)).toString()
        : perTp.toString()

      // Align TP price: ceil for Sell (closing LONG), floor for Buy (closing SHORT)
      const tpDirection = side === 'Sell' ? 'ceil' : 'floor'
      const alignedPrice = alignToTickSize(takeProfits[i], tickSize, tpDirection)

      let lastError: Error | null = null
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const response = await this.client.submitOrder({
            category: 'linear',
            symbol,
            side,
            orderType: 'Limit',
            qty,
            price: alignedPrice,
            timeInForce: 'GTC',
            positionIdx: 0,
            reduceOnly: true,
            orderLinkId: `sig-${signalId}-tp${i + 1}`,
          })

          if (response.retCode !== 0) {
            throw new Error(`TP${i + 1}: ${response.retMsg}`)
          }

          orderIds.push(response.result.orderId)

          await logOrderAction('TP_ORDER_PLACED', {
            signalId,
            details: {
              symbol,
              tpLevel: i + 1,
              price: alignedPrice,
              qty,
              orderId: response.result.orderId,
              orderLinkId: `sig-${signalId}-tp${i + 1}`,
            },
          })

          lastError = null
          break
        } catch (err: any) {
          lastError = err
          console.error(`[OrderExecutor] TP${i + 1} attempt ${attempt}/3 failed: ${err.message}`)
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, 500 * attempt))
          }
        }
      }

      if (lastError) {
        await logOrderAction('ERROR', {
          signalId,
          details: {
            error: lastError.message,
            action: `place_tp${i + 1}_failed_after_3_attempts`,
            symbol,
            price: alignedPrice,
            qty,
          },
        })
        // Continue to next TP -- do not throw
      }
    }

    return orderIds
  }
}

/**
 * Factory function to create an OrderExecutor instance.
 */
export function createOrderExecutor(client: RestClientV5): OrderExecutor {
  return new OrderExecutor(client)
}
