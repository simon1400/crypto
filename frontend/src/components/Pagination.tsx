interface PaginationProps {
  page: number
  totalPages: number
  onPageChange: (page: number) => void
  total?: number
  className?: string
}

export default function Pagination({ page, totalPages, onPageChange, total, className }: PaginationProps) {
  if (totalPages <= 1) return null

  return (
    <div className={className || 'flex items-center justify-center gap-2'}>
      {total !== undefined && (
        <span className="text-text-secondary text-xs mr-auto">
          Всего: {total}
        </span>
      )}
      <button
        onClick={() => onPageChange(Math.max(1, page - 1))}
        disabled={page <= 1}
        className="px-3 py-1.5 rounded-lg text-sm text-text-secondary hover:text-text-primary disabled:opacity-30 transition-colors"
      >
        ←
      </button>
      <span className="px-3 py-1.5 text-sm text-text-secondary">
        {page} / {totalPages}
      </span>
      <button
        onClick={() => onPageChange(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
        className="px-3 py-1.5 rounded-lg text-sm text-text-secondary hover:text-text-primary disabled:opacity-30 transition-colors"
      >
        →
      </button>
    </div>
  )
}
