import { useState } from 'react'
import { activateKillSwitch } from '../api/client'
import ConfirmDialog from './ConfirmDialog'

interface Props {
  onActivated?: () => void
}

export default function KillSwitchButton({ onActivated }: Props) {
  const [showConfirm, setShowConfirm] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleConfirm = async () => {
    setLoading(true)
    try {
      await activateKillSwitch()
      onActivated?.()
      setShowConfirm(false)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Kill switch failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <button
        onClick={() => setShowConfirm(true)}
        className="bg-short/10 text-short hover:bg-short/20 border border-short/30 px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors flex items-center gap-1.5"
      >
        <svg viewBox="0 0 10 10" className="w-3.5 h-3.5 fill-current">
          <rect x="1" y="1" width="8" height="8" rx="1" />
        </svg>
        Kill Switch
      </button>

      <ConfirmDialog
        open={showConfirm}
        title="Экстренная остановка"
        variant="danger"
        confirmLabel="Подтвердить"
        loading={loading}
        onConfirm={handleConfirm}
        onCancel={() => setShowConfirm(false)}
      >
        <p className="text-text-secondary text-sm leading-relaxed">
          Все открытые ордера будут отменены. Автоматический режим будет отключен.
          Существующие позиции останутся с их SL/TP на Bybit.
        </p>
      </ConfirmDialog>
    </>
  )
}
