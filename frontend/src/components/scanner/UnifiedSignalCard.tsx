import { useState } from 'react'
import { takeSignalAsTrade, takeSignal, skipSignal } from '../../api/client'
import {
  CardData, CardMode, SavedProps, ScanProps, Props,
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
  const { mode, balance, riskPct } = props
  const data: CardData = mode === 'saved'
    ? normalizeFromSaved((props as SavedProps).signal)
    : normalizeFromScan((props as ScanProps).signal)

  const [expanded, setExpanded] = useState(false)
  const [showTakeForm, setShowTakeForm] = useState(false)
  const [selectedModel, setSelectedModel] = useState(0)
  const [amount, setAmount] = useState('')
  const [customLeverage, setCustomLeverage] = useState('')
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market')
  const [loading, setLoading] = useState(false)

  const models = data.entryModels
  const active = models[selectedModel] || models[0]
  const tps = active?.takeProfits || data.takeProfits

  const isRejected = mode === 'scan' && data.legacyCategory === 'REJECTED'

  function calcRiskAmount(lev?: number) {
    if (!balance || !riskPct) return ''
    const sl = active?.slPercent || data.slPercent
    const leverage = lev || active?.leverage || data.leverage
    if (!sl || !leverage) return ''
    return String(Math.floor((balance * riskPct / 100) / (sl / 100 * leverage)))
  }

  function openTakeForm() {
    setAmount(calcRiskAmount())
    setCustomLeverage('')
    setShowTakeForm(true)
  }

  async function handleTakeSaved() {
    if (!amount || mode !== 'saved') return
    setLoading(true)
    try {
      const lev = customLeverage ? Number(customLeverage) : undefined
      await takeSignalAsTrade(data.id!, Number(amount), active?.type, lev, orderType)
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

  function handleTakeScan() {
    if (!amount || mode !== 'scan' || !data.id) return
    const lev = customLeverage ? Number(customLeverage) : undefined
    ;(props as ScanProps).onTake(data.id, Number(amount), active?.type, lev, orderType)
    setShowTakeForm(false)
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
          balance={balance}
          riskPct={riskPct}
          calcRiskAmount={calcRiskAmount}
        />
      )}
      <SignalCardActions
        data={data}
        mode={mode}
        showTakeForm={showTakeForm}
        onOpenTakeForm={openTakeForm}
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
