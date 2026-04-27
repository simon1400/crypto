import { useState } from 'react'
import { takeSignalAsTrade, takeSignalAsRealTrade, takeSignal, skipSignal } from '../../api/client'
import {
  CardData, SavedProps, ScanProps, Props, TakeMode,
  normalizeFromSaved, normalizeFromScan,
} from './types'

/**
 * Humanize common Bybit errors so alert() shows something actionable.
 * Raw error comes from realOrderForGenSignal / Bybit retMsg.
 */
function formatRealError(raw: string | null | undefined): string {
  if (!raw) return 'Неизвестная ошибка'

  // maxLeverage: "cannot set leverage [600] gt maxLeverage [500] by risk limit"
  const maxLevMatch = raw.match(/leverage\s*\[(\d+)\][^[]*maxLeverage\s*\[(\d+)\]/i)
  if (maxLevMatch) {
    const wanted = Number(maxLevMatch[1])
    const max = Number(maxLevMatch[2])
    return `Плечо ${wanted}x превышает лимит Bybit для этой монеты (max ${max}x по risk limit tier). Уменьши Leverage в форме и попробуй снова.`
  }

  if (/API keys not configured/i.test(raw)) {
    return 'API-ключи Bybit не настроены. Проверь Настройки.'
  }
  if (/testnet/i.test(raw)) {
    return 'Bybit подключен к testnet. Переключись на mainnet в Настройках.'
  }
  if (/SL\s+\S+\s+(>=|<=)/i.test(raw)) {
    return `Stop Loss уже за текущей ценой — цена успела дойти до SL. ${raw}`
  }
  if (/Symbol.*not found/i.test(raw) || /not on Bybit/i.test(raw)) {
    return `Монета отсутствует на Bybit. ${raw}`
  }
  if (/< минимума/i.test(raw) || /min.*qty/i.test(raw)) {
    return `Размер позиции меньше минимального лота Bybit. Увеличь сумму. ${raw}`
  }
  if (/insufficient/i.test(raw) || /balance/i.test(raw)) {
    return `Недостаточно средств на Bybit. ${raw}`
  }

  return raw
}
import SignalCardHeader from './SignalCardHeader'
import SignalCardScores from './SignalCardScores'
import SignalCardModels from './SignalCardModels'
import SignalCardContext from './SignalCardContext'
import SignalCardTakeForm from './SignalCardTakeForm'
import SignalCardActions from './SignalCardActions'

export type { SavedProps, ScanProps } from './types'

export default function UnifiedSignalCard(props: Props) {
  const { mode, balance, riskPct, realBalance } = props
  const data: CardData = mode === 'saved'
    ? normalizeFromSaved((props as SavedProps).signal)
    : normalizeFromScan((props as ScanProps).signal)

  const [showTakeForm, setShowTakeForm] = useState(false)
  const [takeMode, setTakeMode] = useState<TakeMode>('demo')
  const [selectedModel, setSelectedModel] = useState(0)
  const [amount, setAmount] = useState('')
  const [customLeverage, setCustomLeverage] = useState('')
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market')
  const [loading, setLoading] = useState(false)

  // Inline error inside take-form (real order failed → show, keep form open, let user fix)
  const [formError, setFormError] = useState<string | null>(null)

  const models = data.entryModels
  const active = models[selectedModel] || models[0]
  const tps = active?.takeProfits || data.takeProfits

  const isRejected = mode === 'scan' && data.legacyCategory === 'REJECTED'

  // Pick balance source: real Bybit balance for real-mode, virtual depo for demo
  const effectiveBalance = takeMode === 'real' ? (realBalance ?? 0) : balance

  function calcRiskAmount(lev?: number) {
    if (!effectiveBalance || !riskPct) return ''
    const sl = active?.slPercent || data.slPercent
    const leverage = lev || active?.leverage || data.leverage
    if (!sl || !leverage) return ''
    return String(Math.floor((effectiveBalance * riskPct / 100) / (sl / 100 * leverage)))
  }

  function openTakeForm(nextMode: TakeMode) {
    setTakeMode(nextMode)
    setCustomLeverage('')
    setFormError(null)
    // calc amount using next-mode balance directly
    const baseBalance = nextMode === 'real' ? (realBalance ?? 0) : balance
    if (baseBalance && riskPct) {
      const sl = active?.slPercent || data.slPercent
      const leverage = active?.leverage || data.leverage
      if (sl && leverage) {
        setAmount(String(Math.floor((baseBalance * riskPct / 100) / (sl / 100 * leverage))))
      } else {
        setAmount('')
      }
    } else {
      setAmount('')
    }
    setShowTakeForm(true)
  }

  async function handleTakeSaved() {
    if (!amount || mode !== 'saved') return
    setLoading(true)
    setFormError(null)
    try {
      const lev = customLeverage ? Number(customLeverage) : undefined
      if (takeMode === 'real') {
        // realRequired: при ошибке реала бэк не создаёт демо и не меняет статус сигнала
        const res = await takeSignalAsRealTrade(data.id!, Number(amount), active?.type, lev, orderType, true)
        if (res.real) {
          // Успех: показать модал через родителя (переживёт refetch карточки)
          ;(props as SavedProps).onRealOrderSuccess?.({ kind: 'success', info: res.real, demoSkippedReason: res.demoSkippedReason })
          setShowTakeForm(false)
          ;(props as SavedProps).onStatusChange()
        } else {
          // Ошибка: показать в форме, форма остаётся открытой, юзер правит и жмёт снова
          setFormError(formatRealError(res.realError))
        }
      } else {
        await takeSignalAsTrade(data.id!, Number(amount), active?.type, lev, orderType)
        setShowTakeForm(false)
        ;(props as SavedProps).onStatusChange()
      }
    } catch (err: any) {
      setFormError(err?.message || 'Failed to take signal')
    } finally { setLoading(false) }
  }

  async function handleSkipSaved() {
    if (mode !== 'saved') return
    try {
      await skipSignal(data.id!)
      ;(props as SavedProps).onStatusChange()
    } catch (err: any) { alert(err?.message || 'Operation failed') }
  }

  async function handleMarkSaved() {
    if (mode !== 'saved') return
    try {
      await takeSignal(data.id!, 0)
      ;(props as SavedProps).onStatusChange()
    } catch (err: any) { alert(err?.message || 'Failed to take signal') }
  }

  async function handleTakeScan() {
    if (!amount || mode !== 'scan' || !data.id) return
    const lev = customLeverage ? Number(customLeverage) : undefined
    if (takeMode === 'real') {
      setLoading(true)
      setFormError(null)
      try {
        // realRequired: бэк не создаст демо и не сменит статус, если реал упал
        const res = await takeSignalAsRealTrade(data.id, Number(amount), active?.type, lev, orderType, true)
        if (res.real) {
          ;(props as ScanProps).onRealOrderSuccess?.({ kind: 'success', info: res.real, demoSkippedReason: res.demoSkippedReason })
          setShowTakeForm(false)
          // parent refresh пометит карточку как _taken — но модал уже у Scanner.tsx
          ;(props as ScanProps).onTake(data.id, Number(amount), active?.type, lev, orderType)
        } else {
          // Ошибка реала — форма остаётся открытой, демо НЕ создано
          setFormError(formatRealError(res.realError))
        }
      } catch (err: any) {
        setFormError(err?.message || 'Failed to take signal')
      } finally { setLoading(false) }
    } else {
      ;(props as ScanProps).onTake(data.id, Number(amount), active?.type, lev, orderType)
      setShowTakeForm(false)
    }
  }

  return (
    <div className={`bg-card rounded-xl p-4 border ${isRejected ? 'border-short/20 opacity-60' : 'border-card hover:border-accent/30'} transition-colors`}>
      <SignalCardHeader
        data={data}
        mode={mode}
        onShowChart={mode === 'saved' && (props as SavedProps).onShowChart
          ? () => (props as SavedProps).onShowChart!((props as SavedProps).signal)
          : undefined}
      />
      <SignalCardModels
        models={models}
        selectedModel={selectedModel}
        onSelectModel={setSelectedModel}
        data={data}
        active={active}
        tps={tps}
      />
      <SignalCardScores
        scoreBreakdown={data.scoreBreakdown}
        legacyScoreBreakdown={data.legacyScoreBreakdown}
        entryTriggerResult={data.entryTriggerResult}
      />
      <SignalCardContext
        data={data}
        active={active}
      />
      {showTakeForm && (
        <>
          {/* Mode banner */}
          <div className={`text-xs px-3 py-1.5 rounded-t-lg -mb-2 mt-2 ${takeMode === 'real' ? 'bg-accent/10 text-accent border border-b-0 border-accent/30' : 'bg-long/10 text-long border border-b-0 border-long/30'}`}>
            {takeMode === 'real'
              ? <>🔴 Реальная сделка на Bybit + демо · баланс: <span className="font-mono">${(realBalance ?? 0).toFixed(2)}</span></>
              : <>📊 Демо сделка · баланс: <span className="font-mono">${balance.toFixed(2)}</span></>
            }
          </div>
          <SignalCardTakeForm
            data={data}
            active={active}
            amount={amount}
            onAmountChange={(v) => { setAmount(v); if (formError) setFormError(null) }}
            customLeverage={customLeverage}
            onCustomLeverageChange={(v) => { setCustomLeverage(v); if (formError) setFormError(null) }}
            orderType={orderType}
            onOrderTypeChange={setOrderType}
            onConfirm={mode === 'saved' ? handleTakeSaved : handleTakeScan}
            onCancel={() => { setShowTakeForm(false); setFormError(null) }}
            loading={loading}
            balance={effectiveBalance}
            riskPct={riskPct}
            calcRiskAmount={calcRiskAmount}
            errorMessage={formError}
          />
        </>
      )}
      <SignalCardActions
        data={data}
        mode={mode}
        showTakeForm={showTakeForm}
        onOpenTakeForm={() => openTakeForm('demo')}
        onOpenTakeFormReal={() => openTakeForm('real')}
        onTakeSaved={handleTakeSaved}
        onSkipSaved={handleSkipSaved}
        onTakeScan={handleTakeScan}
        onSkipScan={() => mode === 'scan' && (props as ScanProps).onSkip(data.id!)}
        onMarkSaved={handleMarkSaved}
        onDelete={() => props.onDelete(data.id!)}
      />
    </div>
  )
}

/**
 * Модал результата успешной реал-сделки.
 * Рендерится в Scanner.tsx чтобы пережить refetch карточек после take.
 */
export function RealOrderSuccessModal({
  info,
  demoSkippedReason,
  onClose,
}: {
  info: import('../../api/client').RealOrderInfo
  demoSkippedReason?: string | null
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-card rounded-xl p-5 max-w-md w-full border border-long/40"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-long">✓ Реальная сделка создана на Bybit</h3>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <div className="text-sm text-text-primary mb-3">
          {demoSkippedReason ? 'Реальная сделка создана на Bybit. Демо пропущено — не хватает виртуального баланса.' : 'Демо + реальная сделка успешно созданы.'}
        </div>
        {demoSkippedReason && (
          <div className="bg-input rounded p-2 text-xs text-accent font-mono break-words mb-3">
            {demoSkippedReason}
          </div>
        )}
        <div className="space-y-1.5 text-sm font-mono bg-input rounded p-3">
          <div><span className="text-text-secondary">Символ: </span><span className="text-text-primary">{info.symbol}</span></div>
          <div><span className="text-text-secondary">Position ID: </span><span className="text-text-primary">#{info.positionId}</span></div>
          <div><span className="text-text-secondary">Тип ордера: </span><span className="text-text-primary">{info.orderType}</span></div>
          <div><span className="text-text-secondary">Кол-во: </span><span className="text-text-primary">{info.qty}</span></div>
          {info.entryPrice && (
            <div><span className="text-text-secondary">Лимит-цена: </span><span className="text-text-primary">${info.entryPrice}</span></div>
          )}
          <div><span className="text-text-secondary">Stop Loss: </span><span className="text-short">${info.stopLoss}</span></div>
          <div className="pt-1">
            <span className="text-text-secondary">Take Profits:</span>
            <div className="mt-1 space-y-0.5 pl-2">
              {info.takeProfits.map((tp, i) => (
                <div key={i} className="text-xs">
                  <span className="text-text-secondary">TP{i + 1} ({tp.percent}%): </span>
                  <span className={tp.orderId ? 'text-long' : 'text-short'}>${tp.price}</span>
                  <span className="text-text-secondary"> · {tp.qty}</span>
                  {!tp.orderId && tp.error && (
                    <span className="text-short ml-1">✕ {tp.error}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <button
          onClick={onClose}
          className="mt-4 w-full py-2 rounded font-medium bg-long/15 text-long hover:bg-long/25"
        >
          Закрыть
        </button>
      </div>
    </div>
  )
}
