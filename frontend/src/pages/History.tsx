import { useState, useEffect } from 'react'
import HistoryTable from '../components/HistoryTable'
import { getHistory, Analysis, HistoryResponse } from '../api/client'

export default function History() {
  const [data, setData] = useState<HistoryResponse | null>(null)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState<Analysis | null>(null)

  useEffect(() => {
    setLoading(true)
    getHistory(page)
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [page])

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">История анализов</h1>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="w-10 h-10 border-4 border-card border-t-accent rounded-full animate-spin" />
        </div>
      ) : data ? (
        <>
          <HistoryTable data={data.data} onView={setModal} />

          {data.totalPages > 1 && (
            <div className="flex justify-center gap-2">
              {Array.from({ length: data.totalPages }, (_, i) => i + 1).map((p) => (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  className={`w-9 h-9 rounded-lg text-sm font-medium transition-colors ${
                    p === page
                      ? 'bg-accent text-primary'
                      : 'bg-card text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="text-text-secondary">Ошибка загрузки</p>
      )}

      {modal && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={() => setModal(null)}
        >
          <div
            className="bg-card rounded-xl max-w-3xl w-full max-h-[80vh] overflow-y-auto p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-4">
              <div>
                <h2 className="text-lg font-semibold">
                  Анализ: {modal.coins.split(',').join(', ')}
                </h2>
                <p className="text-xs text-text-secondary">
                  {new Date(modal.createdAt).toLocaleString('ru-RU')}
                </p>
              </div>
              <button
                onClick={() => setModal(null)}
                className="text-text-secondary hover:text-text-primary text-2xl leading-none"
              >
                &times;
              </button>
            </div>
            <div className="whitespace-pre-wrap text-sm leading-relaxed">
              {modal.result}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
