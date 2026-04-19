import { EventEmitter } from 'events'

/**
 * In-memory progress tracker для сканера.
 *
 * Один глобальный singleton — сканер крутится только один за раз
 * (защищено isScannerRunning()), поэтому общее состояние безопасно.
 *
 * SSE endpoint подписывается на 'update' и пересылает события клиенту.
 */

export type ScanPhase =
  | 'idle'
  | 'starting'
  | 'market_data'   // funding/OI/news/LSR fetch
  | 'fetching'      // 5m/15m/1h/4h candles fetch (per-coin batch)
  | 'regime'        // detect market regime from BTC
  | 'scoring'       // strategies + 3-layer scoring (hard filters → setup → entry trigger)
  | 'risk_calc'     // legacy (kept for backward compat with old frontend)
  | 'classifying'   // classification + build results (per-signal progress)
  | 'saving'        // save to DB
  | 'done'
  | 'error'

export interface ScanProgress {
  phase: ScanPhase
  message: string         // human-readable текст для UI
  current: number         // текущая позиция
  total: number           // общий объём (0 если не применимо)
  percent: number         // 0-100
  startedAt: number       // ms timestamp
  updatedAt: number
  // optional: накопленные счётчики из funnel
  candidates?: number
  passed?: number
  rejected?: number
  error?: string
}

class ScannerProgress extends EventEmitter {
  private state: ScanProgress = {
    phase: 'idle',
    message: 'Ожидание',
    current: 0,
    total: 0,
    percent: 0,
    startedAt: 0,
    updatedAt: 0,
  }

  private _aborted = false

  get aborted(): boolean {
    return this._aborted
  }

  /** Request scan cancellation — checked by runScan loops */
  abort(): void {
    this._aborted = true
    this.state = {
      ...this.state,
      phase: 'error',
      message: 'Сканирование остановлено',
      error: 'Остановлено пользователем',
      updatedAt: Date.now(),
    }
    this.emit('update', this.getState())
  }

  getState(): ScanProgress {
    return { ...this.state }
  }

  start(totalCoins: number): void {
    this._aborted = false
    this.state = {
      phase: 'starting',
      message: `Запуск сканирования ${totalCoins} монет...`,
      current: 0,
      total: totalCoins,
      percent: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.emit('update', this.getState())
  }

  setPhase(phase: ScanPhase, message: string, current = 0, total = 0): void {
    this.state.phase = phase
    this.state.message = message
    this.state.current = current
    this.state.total = total
    this.state.percent = total > 0 ? Math.round((current / total) * 100) : this.state.percent
    this.state.updatedAt = Date.now()
    this.emit('update', this.getState())
  }

  /** Обновить прогресс внутри текущей фазы (например, "fetched 35/125 coins") */
  tick(current: number, total?: number, message?: string): void {
    this.state.current = current
    if (total !== undefined) this.state.total = total
    if (message) this.state.message = message
    this.state.percent = this.state.total > 0
      ? Math.round((current / this.state.total) * 100)
      : this.state.percent
    this.state.updatedAt = Date.now()
    this.emit('update', this.getState())
  }

  /** Применить накопленные счётчики из funnel */
  setCounters(c: { candidates?: number; passed?: number; rejected?: number }): void {
    if (c.candidates !== undefined) this.state.candidates = c.candidates
    if (c.passed !== undefined) this.state.passed = c.passed
    if (c.rejected !== undefined) this.state.rejected = c.rejected
    this.state.updatedAt = Date.now()
    this.emit('update', this.getState())
  }

  done(message: string, totalSignals: number): void {
    this.state = {
      ...this.state,
      phase: 'done',
      message,
      current: this.state.total,
      percent: 100,
      passed: totalSignals,
      updatedAt: Date.now(),
    }
    this.emit('update', this.getState())
  }

  error(message: string): void {
    this.state = {
      ...this.state,
      phase: 'error',
      message,
      error: message,
      updatedAt: Date.now(),
    }
    this.emit('update', this.getState())
  }

  reset(): void {
    this._aborted = false
    this.state = {
      phase: 'idle',
      message: 'Ожидание',
      current: 0,
      total: 0,
      percent: 0,
      startedAt: 0,
      updatedAt: 0,
    }
  }
}

export const scannerProgress = new ScannerProgress()
// Чтобы EventEmitter не ругался на множество SSE подписчиков
scannerProgress.setMaxListeners(100)
