import { useState, useEffect, useRef } from 'react'
import { searchSymbols } from '../../api/client'

export default function CoinSearchSelector({ selected, onChange, max }: {
  selected: string[]
  onChange: (coins: string[]) => void
  max: number
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<string[]>([])
  const [focused, setFocused] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setFocused(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function handleInput(value: string) {
    const q = value.toUpperCase()
    setQuery(q)
    setFocused(true)

    if (q.length < 1) { setResults([]); return }

    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await searchSymbols(q)
        setResults(res.filter(c => !selected.includes(c)))
      } catch {
        setResults([])
      }
    }, 150)
  }

  function add(coin: string) {
    if (selected.length < max) {
      onChange([...selected, coin])
    }
    setQuery('')
    setResults([])
    setFocused(false)
  }

  return (
    <div ref={ref} className="relative">
      <input
        type="text"
        value={query}
        onChange={e => handleInput(e.target.value)}
        onFocus={() => { setFocused(true); if (query) handleInput(query) }}
        placeholder={selected.length >= max ? `Максимум ${max}` : 'Поиск монеты...'}
        disabled={selected.length >= max}
        className="w-40 bg-input text-text-primary rounded-lg px-3 py-1.5 text-sm border border-transparent focus:border-accent/40 focus:outline-none placeholder:text-text-secondary disabled:opacity-50"
      />
      {focused && results.length > 0 && (
        <div className="absolute top-full mt-1 left-0 w-48 max-h-48 overflow-y-auto bg-card border border-card rounded-lg shadow-lg z-50">
          {results.slice(0, 20).map(c => (
            <button
              key={c}
              onMouseDown={e => e.preventDefault()}
              onClick={() => add(c)}
              className="w-full text-left px-3 py-1.5 text-sm text-text-primary hover:bg-input transition-colors"
            >
              {c}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
