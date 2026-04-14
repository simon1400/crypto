import { useState, useEffect } from 'react'
import { getScannerCoinList, saveScannerCoinList } from '../../api/scanner'

interface ScannerCoinListTabProps {
  onCoinCountChange: (count: number) => void
}

export default function ScannerCoinListTab({ onCoinCountChange }: ScannerCoinListTabProps) {
  const [allCoins, setAllCoins] = useState<string[]>([])
  const [bingxOnlySet, setBingxOnlySet] = useState<Set<string>>(new Set())
  const [selectedCoins, setSelectedCoins] = useState<string[]>([])
  const [coinSearch, setCoinSearch] = useState('')
  const [coinListLoading, setCoinListLoading] = useState(false)
  const [coinListSaving, setCoinListSaving] = useState(false)

  useEffect(() => {
    async function loadCoinList() {
      setCoinListLoading(true)
      try {
        const data = await getScannerCoinList()
        setAllCoins(data.available)
        setBingxOnlySet(new Set(data.bingxOnly || []))
        setSelectedCoins(data.selected)
        onCoinCountChange(data.selected.length)
      } catch (err) { console.error('[Scanner] Failed to load coin list:', err) } finally {
        setCoinListLoading(false)
      }
    }
    loadCoinList()
  }, [])

  async function handleSaveCoinList() {
    setCoinListSaving(true)
    try {
      await saveScannerCoinList(selectedCoins)
      onCoinCountChange(selectedCoins.length)
    } catch (err: any) { alert(err?.message || 'Failed to save coin list') } finally {
      setCoinListSaving(false)
    }
  }

  function toggleCoin(coin: string) {
    setSelectedCoins(prev =>
      prev.includes(coin) ? prev.filter(c => c !== coin) : [...prev, coin]
    )
  }

  function selectAllFiltered(coins: string[]) {
    setSelectedCoins(prev => {
      const set = new Set(prev)
      coins.forEach(c => set.add(c))
      return [...set]
    })
  }

  function deselectAllFiltered(coins: string[]) {
    setSelectedCoins(prev => prev.filter(c => !coins.includes(c)))
  }

  const filteredCoins = allCoins.filter(c => !coinSearch || c.includes(coinSearch))

  return (
    <div className="space-y-4">
      {coinListLoading ? (
        <p className="text-text-secondary text-sm">Загрузка списка монет с Bybit + BingX...</p>
      ) : (
        <>
          {/* Controls */}
          <div className="flex items-center gap-3 flex-wrap">
            <input
              type="text"
              value={coinSearch}
              onChange={e => setCoinSearch(e.target.value.toUpperCase())}
              placeholder="Поиск монеты..."
              className="bg-input text-text-primary rounded-lg px-3 py-2 text-sm border border-card focus:border-accent outline-none w-48"
            />
            <span className="text-text-secondary text-sm">
              Выбрано: <span className="text-accent font-mono">{selectedCoins.length}</span> из {allCoins.length}
              {bingxOnlySet.size > 0 && (
                <span className="ml-1">
                  (<span className="text-amber-400 font-mono">{bingxOnlySet.size}</span> только BingX)
                </span>
              )}
            </span>
            <button
              onClick={() => {
                const filtered = allCoins.filter(c => !coinSearch || c.includes(coinSearch))
                const allSelected = filtered.every(c => selectedCoins.includes(c))
                allSelected ? deselectAllFiltered(filtered) : selectAllFiltered(filtered)
              }}
              className="px-3 py-1.5 bg-input text-text-secondary rounded-lg text-xs hover:text-text-primary transition-colors"
            >
              {coinSearch
                ? (filteredCoins.every(c => selectedCoins.includes(c)) ? 'Снять найденные' : 'Выбрать найденные')
                : (selectedCoins.length === allCoins.length ? 'Снять все' : 'Выбрать все')}
            </button>
            <button
              onClick={() => setSelectedCoins([])}
              className="px-3 py-1.5 bg-short/20 text-short rounded-lg text-xs hover:bg-short/30 transition-colors"
            >
              Очистить
            </button>
            <button
              onClick={handleSaveCoinList}
              disabled={coinListSaving}
              className="px-4 py-1.5 bg-accent text-primary font-bold rounded-lg text-sm hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {coinListSaving ? 'Сохраняю...' : 'Сохранить'}
            </button>
          </div>

          {/* Coin grid */}
          <div className="grid grid-cols-6 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12 xl:grid-cols-14 gap-1.5">
            {filteredCoins.map(coin => {
              const isSelected = selectedCoins.includes(coin)
              const isBingx = bingxOnlySet.has(coin)
              return (
                <button
                  key={coin}
                  onClick={() => toggleCoin(coin)}
                  className={`px-2 py-1.5 rounded text-xs font-mono transition-all relative ${
                    isSelected
                      ? isBingx
                        ? 'bg-amber-500/15 text-amber-400 border border-amber-500/50'
                        : 'bg-accent/15 text-accent border border-accent/50'
                      : 'bg-card text-text-secondary border border-transparent hover:border-card hover:text-text-primary'
                  }`}
                  title={isBingx ? 'Только BingX' : 'Bybit'}
                >
                  {coin}
                  {isBingx && <span className="absolute -top-1 -right-1 w-1.5 h-1.5 bg-amber-400 rounded-full" />}
                </button>
              )
            })}
          </div>

          {allCoins.length > 0 && filteredCoins.length === 0 && (
            <p className="text-text-secondary text-sm text-center py-4">Ничего не найдено</p>
          )}
        </>
      )}
    </div>
  )
}
