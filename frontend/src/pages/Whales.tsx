import { useState } from 'react'
import { scanWhales, WhaleScanResponse, WhaleData, TokenTransfer } from '../api/client'

function shortAddr(addr: string) {
  return addr.slice(0, 6) + '...' + addr.slice(-4)
}

function timeAgo(ts: number) {
  const diff = Math.floor(Date.now() / 1000 - ts)
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function WhaleCard({ whale }: { whale: WhaleData }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="bg-card rounded-xl p-5 border border-card hover:border-accent/30 transition-colors">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-text-primary">{whale.name}</h3>
          <p className="text-xs text-text-secondary">{whale.description}</p>
          <a
            href={`https://etherscan.io/address/${whale.address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-accent hover:underline font-mono"
          >
            {shortAddr(whale.address)}
          </a>
        </div>
        <div className="text-right">
          <div className="text-xs text-text-secondary">ETH Balance</div>
          <div className="font-mono text-lg font-bold text-text-primary">
            {whale.ethBalance.toLocaleString()} ETH
          </div>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        <div className="bg-long/10 rounded-lg p-3 text-center">
          <div className="text-xs text-text-secondary">Покупки (IN)</div>
          <div className="font-mono text-xl font-bold text-long">{whale.summary.totalBuys}</div>
        </div>
        <div className="bg-short/10 rounded-lg p-3 text-center">
          <div className="text-xs text-text-secondary">Продажи (OUT)</div>
          <div className="font-mono text-xl font-bold text-short">{whale.summary.totalSells}</div>
        </div>
      </div>

      {/* Top tokens */}
      {whale.summary.topTokens.length > 0 && (
        <div className="mb-4">
          <h4 className="text-sm text-text-secondary mb-2">Топ токены (за 3 дня):</h4>
          <div className="flex flex-wrap gap-2">
            {whale.summary.topTokens.map((token) => (
              <div
                key={token.symbol}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${
                  token.direction === 'BUY'
                    ? 'bg-long/10 text-long border-long/30'
                    : 'bg-short/10 text-short border-short/30'
                }`}
              >
                <span className="font-mono font-bold">{token.symbol}</span>
                <span className="ml-1.5 opacity-80">
                  {token.direction === 'BUY' ? '↑' : '↓'} {token.netAmount.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Transactions toggle */}
      {whale.transfers.length > 0 && (
        <div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-sm text-accent hover:text-accent/80 transition-colors"
          >
            {expanded ? '▾ Скрыть' : '▸ Показать'} транзакции ({whale.transfers.length})
          </button>

          {expanded && (
            <div className="mt-3 space-y-1 max-h-80 overflow-y-auto">
              {whale.transfers.map((tx, i) => (
                <TransferRow key={`${tx.hash}-${i}`} tx={tx} whaleAddress={whale.address} />
              ))}
            </div>
          )}
        </div>
      )}

      {whale.transfers.length === 0 && (
        <p className="text-sm text-text-secondary">Нет токен-транзакций за последние 3 дня</p>
      )}
    </div>
  )
}

function TransferRow({ tx, whaleAddress }: { tx: TokenTransfer; whaleAddress: string }) {
  const isIn = tx.direction === 'IN'
  return (
    <div className="flex items-center justify-between bg-input rounded-lg px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className={`font-bold ${isIn ? 'text-long' : 'text-short'}`}>
          {isIn ? 'IN ↓' : 'OUT ↑'}
        </span>
        <span className="font-mono font-semibold text-text-primary">{tx.tokenSymbol}</span>
        <span className="text-text-secondary font-mono">{tx.valueFormatted.toLocaleString()}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-text-secondary">{timeAgo(tx.timestamp)}</span>
        <a
          href={`https://etherscan.io/tx/${tx.hash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          tx
        </a>
      </div>
    </div>
  )
}

export default function Whales() {
  const [data, setData] = useState<WhaleScanResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleScan = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await scanWhales()
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сканирования')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Whale Tracker</h1>
          <p className="text-text-secondary mt-1">Отслеживание топ-3 крипто-кошельков за последние 3 дня</p>
        </div>
        <button
          onClick={handleScan}
          disabled={loading}
          className="px-6 py-3 bg-accent text-primary font-bold rounded-lg text-sm hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Сканирую...' : 'Сканировать'}
        </button>
      </div>

      {error && (
        <div className="bg-short/10 border border-short/30 rounded-lg px-4 py-3 text-short text-sm">
          {error}
        </div>
      )}

      {loading && (
        <div className="text-center py-12">
          <div className="inline-block w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-text-secondary mt-3">Сканирую кошельки через Etherscan...</p>
        </div>
      )}

      {data && !loading && (
        <>
          <p className="text-xs text-text-secondary">
            Последнее сканирование: {new Date(data.scannedAt).toLocaleString('ru-RU')}
          </p>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {data.data.map((whale) => (
              <WhaleCard key={whale.address} whale={whale} />
            ))}
          </div>
        </>
      )}

      {!data && !loading && (
        <div className="text-center py-16 text-text-secondary">
          <p className="text-lg">Нажми «Сканировать» чтобы увидеть активность китов</p>
          <p className="text-sm mt-2">Данные загружаются через Etherscan API (бесплатно)</p>
        </div>
      )}
    </div>
  )
}
