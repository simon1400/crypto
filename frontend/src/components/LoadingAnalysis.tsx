import { useState, useEffect } from 'react'

const MESSAGES = [
  'Получаю данные Binance...',
  'Считаю индикаторы...',
  'Claude анализирует рынок...',
  'Формирую торговый план...',
]

export default function LoadingAnalysis() {
  const [index, setIndex] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setIndex((i) => (i + 1) % MESSAGES.length)
    }, 3000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="flex flex-col items-center justify-center py-20 gap-4">
      <div className="w-12 h-12 border-4 border-card border-t-accent rounded-full animate-spin" />
      <p className="text-text-secondary text-lg animate-pulse">{MESSAGES[index]}</p>
    </div>
  )
}
