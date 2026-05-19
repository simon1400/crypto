interface Props {
  page: number
  pageSize: number
  total: number
  loading: boolean
  onChange: (page: number) => void
  /** Where to render — controls border/spacing. Default 'inside' (under thead). */
  layout?: 'inside' | 'standalone'
}

/** "X–Y of N" pagination footer used inside trades / signals tables. */
export default function TablePagination({ page, pageSize, total, loading, onChange, layout = 'inside' }: Props) {
  if (total <= pageSize) return null
  const totalPages = Math.ceil(total / pageSize)
  const from = (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)

  const wrapperCls = layout === 'inside'
    ? 'flex items-center justify-between px-3 py-2 border-t border-input text-xs text-text-secondary'
    : 'flex items-center justify-between px-3 py-2 bg-card border border-input rounded text-xs text-text-secondary'

  return (
    <div className={wrapperCls}>
      <div>{from}–{to} из {total}</div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onChange(Math.max(1, page - 1))}
          disabled={page === 1 || loading}
          className="px-2 py-1 rounded bg-input hover:bg-input/70 disabled:opacity-40 disabled:cursor-not-allowed"
        >‹ Назад</button>
        <span className="font-mono">{page} / {totalPages}</span>
        <button
          onClick={() => onChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages || loading}
          className="px-2 py-1 rounded bg-input hover:bg-input/70 disabled:opacity-40 disabled:cursor-not-allowed"
        >Вперёд ›</button>
      </div>
    </div>
  )
}
