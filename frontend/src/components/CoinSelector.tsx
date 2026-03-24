const ALL_COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'AVAX', 'DOT', 'MATIC', 'LINK']

interface Props {
  selected: string[]
  onChange: (coins: string[]) => void
  disabled?: boolean
}

export default function CoinSelector({ selected, onChange, disabled }: Props) {
  const toggle = (coin: string) => {
    if (disabled) return
    if (selected.includes(coin)) {
      onChange(selected.filter((c) => c !== coin))
    } else if (selected.length < 5) {
      onChange([...selected, coin])
    }
  }

  return (
    <div>
      <p className="text-sm text-text-secondary mb-2">
        Выберите 1–5 монет для анализа:
      </p>
      <div className="flex flex-wrap gap-2">
        {ALL_COINS.map((coin) => {
          const active = selected.includes(coin)
          return (
            <button
              key={coin}
              onClick={() => toggle(coin)}
              disabled={disabled}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all border ${
                active
                  ? 'border-accent text-accent bg-accent/10'
                  : 'border-card text-text-secondary bg-card hover:border-text-secondary'
              } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              {coin}
            </button>
          )
        })}
      </div>
    </div>
  )
}
