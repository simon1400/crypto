import { useState } from 'react'
import { takeSignalAsTrade, takeSignalAsRealTrade, takeSignal, skipSignal, RealOrderInfo } from '../../api/client'
import {
  CardData, CardMode, SavedProps, ScanProps, Props, TakeMode,
  normalizeFromSaved, normalizeFromScan,
} from './types'
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

  const [expanded, setExpanded] = useState(false)
  const [showTakeForm, setShowTakeForm] = useState(false)
  const [takeMode, setTakeMode] = useState<TakeMode>('demo')
  const [selectedModel, setSelectedModel] = useState(0)
  const [amount, setAmount] = useState('')
  const [customLeverage, setCustomLeverage] = useState('')
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market')
  const [loading, setLoading] = useState(false)

  // Real-order result modal state
  const [realModal, setRealModal] = useState<
    | { kind: 'success'; info: RealOrderInfo }
    | { kind: 'error'; message: string }
    | null
  >(null)

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
    try {
      const lev = customLeverage ? Number(customLeverage) : undefined
      if (takeMode === 'real') {
        const res = await takeSignalAsRealTrade(data.id!, Number(amount), active?.type, lev, orderType)
        if (res.real) {
          setRealModal({ kind: 'success', info: res.real })
        } else {
          setRealModal({ kind: 'error', message: res.realError || 'Реальная сделка не была создана' })
        }
      } else {
        await takeSignalAsTrade(data.id!, Number(amount), active?.type, lev, orderType)
      }
      setShowTakeForm(false)
      ;(props as SavedProps).onStatusChange()
    } catch (err: any) {
      alert(err.message || 'Failed to take signal')
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
      try {
        const res = await takeSignalAsRealTrade(data.id, Number(amount), active?.type, lev, orderType)
        if (res.real) {
          setRealModal({ kind: 'success', info: res.real })
        } else {
          setRealModal({ kind: 'error', message: res.realError || 'Реальная сделка не была создана' })
        }
        setShowTakeForm(false)
        // mark as taken in scan tab via parent callback shape
        ;(props as ScanProps).onTake(data.id, Number(amount), active?.type, lev, orderType)
      } catch (err: any) {
        alert(err.message || 'Failed to take signal')
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
        expanded={expanded}
        onToggleExpanded={() => setExpanded(e => !e)}
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
            onAmountChange={setAmount}
            customLeverage={customLeverage}
            onCustomLeverageChange={setCustomLeverage}
            orderType={orderType}
            onOrderTypeChange={setOrderType}
            onConfirm={mode === 'saved' ? handleTakeSaved : handleTakeScan}
            onCancel={() => setShowTakeForm(false)}
            loading={loading}
            balance={effectiveBalance}
            riskPct={riskPct}
            calcRiskAmount={calcRiskAmount}
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

      {realModal && (
        <RealOrderModal modal={realModal} onClose={() => setRealModal(null)} />
      )}
    </div>
  )
}

function RealOrderModal({
  modal,
  onClose,
}: {
  modal: { kind: 'success'; info: RealOrderInfo } | { kind: 'error'; message: string }
  onClose: () => void
}) {
  const isError = modal.kind === 'error'
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className={`bg-card rounded-xl p-5 max-w-md w-full border ${isError ? 'border-short/40' : 'border-long/40'}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className={`text-lg font-semibold ${isError ? 'text-short' : 'text-long'}`}>
            {isError ? '⚠ Реальная сделка не создана' : '✓ Реальная сделка создана на Bybit'}
          </h3>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-xl leading-none">×</button>
        </div>

        {isError ? (
          <>
            <div className="text-sm text-text-primary mb-3">
              Демо сделка создана успешно, но реальный ордер на Bybit не прошёл:
            </div>
            <div className="bg-input rounded p-3 text-sm text-short font-mono break-words">
              {modal.message}
            </div>
            <div className="text-xs text-text-secondary mt-3">
              Проверьте: подключен ли mainnet (не testnet), валидны ли API-ключи, есть ли баланс,
              торгуется ли символ на Bybit.
            </div>
          </>
        ) : (
          <>
            <div className="text-sm text-text-primary mb-3">Демо + реальная сделка успешно созданы.</div>
            <div className="space-y-1.5 text-sm font-mono bg-input rounded p-3">
              <div><span className="text-text-secondary">Символ: </span><span className="text-text-primary">{modal.info.symbol}</span></div>
              <div><span className="text-text-secondary">Position ID: </span><span className="text-text-primary">#{modal.info.positionId}</span></div>
              <div><span className="text-text-secondary">Тип ордера: </span><span className="text-text-primary">{modal.info.orderType}</span></div>
              <div><span className="text-text-secondary">Кол-во: </span><span className="text-text-primary">{modal.info.qty}</span></div>
              {modal.info.entryPrice && (
                <div><span className="text-text-secondary">Лимит-цена: </span><span className="text-text-primary">${modal.info.entryPrice}</span></div>
              )}
              <div><span className="text-text-secondary">Stop Loss: </span><span className="text-short">${modal.info.stopLoss}</span></div>
              <div><span className="text-text-secondary">Take Profit (последний): </span><span className="text-long">${modal.info.takeProfit}</span></div>
            </div>
            <div className="text-xs text-text-secondary mt-3">
              Промежуточные TP не выставлены — добавьте их вручную на бирже.
            </div>
          </>
        )}

        <button
          onClick={onClose}
          className={`mt-4 w-full py-2 rounded font-medium ${isError ? 'bg-short/15 text-short hover:bg-short/25' : 'bg-long/15 text-long hover:bg-long/25'}`}
        >
          Закрыть
        </button>
      </div>
    </div>
  )
}
