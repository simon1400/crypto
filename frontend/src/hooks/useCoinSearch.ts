import { useState, useEffect, useRef } from 'react'
import { searchSymbols } from '../api/client'

export function useCoinSearch(initialValue = '') {
  const [coin, setCoin] = useState(initialValue)
  const [query, setQuery] = useState(initialValue)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!query || query.length < 1) { setSuggestions([]); return }
    const timer = setTimeout(async () => {
      try {
        const results = await searchSymbols(query.toUpperCase())
        setSuggestions(results)
      } catch {
        setSuggestions([])
      }
    }, 200)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setShowSuggestions(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  function select(value: string) {
    setCoin(value)
    setQuery(value)
    setShowSuggestions(false)
  }

  function reset(value = '') {
    setCoin(value || initialValue)
    setQuery(value || initialValue)
    setSuggestions([])
    setShowSuggestions(false)
  }

  return {
    coin,
    query,
    setQuery: (v: string) => { setQuery(v.toUpperCase()); setShowSuggestions(true) },
    suggestions,
    showSuggestions,
    setShowSuggestions,
    ref,
    select,
    reset,
    getValue: () => query.toUpperCase() || coin,
  }
}
