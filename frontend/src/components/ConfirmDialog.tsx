interface Props {
  open: boolean
  title: string
  children: React.ReactNode
  onConfirm: () => void
  onCancel: () => void
  confirmLabel: string
  cancelLabel?: string
  variant?: 'danger' | 'primary'
  loading?: boolean
}

export default function ConfirmDialog({
  open,
  title,
  children,
  onConfirm,
  onCancel,
  confirmLabel,
  cancelLabel = 'Отмена',
  variant = 'primary',
  loading = false,
}: Props) {
  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onCancel}
    >
      <div
        className="bg-card rounded-xl p-6 max-w-md w-full mx-4 border border-card"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-text-primary mb-4">{title}</h3>

        {children}

        <div className="flex gap-3 mt-6">
          <button
            onClick={onCancel}
            disabled={loading}
            className="flex-1 py-2.5 rounded-lg bg-input text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={`flex-1 py-2.5 rounded-lg font-semibold transition-colors disabled:opacity-50 ${
              variant === 'danger'
                ? 'bg-short text-white'
                : 'bg-accent text-[#0b0e11]'
            }`}
          >
            {loading ? '...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
