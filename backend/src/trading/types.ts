export interface InstrumentInfo {
  symbol: string;
  minOrderQty: string;
  qtyStep: string;
  tickSize: string;
  minNotionalValue?: string;
}

export type OrderAction =
  | 'ORDER_PLACED' | 'ORDER_FILLED' | 'ORDER_CANCELLED' | 'MARKET_ENTRY'
  | 'SL_TRIGGERED' | 'TP1_HIT' | 'TP2_HIT' | 'TP3_HIT' | 'TP4_HIT' | 'TP5_HIT'
  | 'TP_ORDER_PLACED' | 'POSITION_CLOSED' | 'CLOSED_EXTERNAL'
  | 'RECONCILE_MISMATCH' | 'ERROR' | 'EXPIRED' | 'KILL_SWITCH'
  | 'DAILY_LIMIT_HIT' | 'AUTO_SKIPPED' | 'AUTO_EXECUTED';

export type PositionStatus =
  | 'PENDING_ENTRY' | 'OPEN' | 'PARTIALLY_CLOSED' | 'CLOSED'
  | 'SL_HIT' | 'CANCELLED' | 'CLOSED_EXTERNAL' | 'EXPIRED';

export type SignalType = 'LONG' | 'SHORT';
