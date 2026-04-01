import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { getBalance } from '../api/client'
import KillSwitchButton from './KillSwitchButton'

interface Props {
  onLogout?: () => void
}

export default function Navbar({ onLogout }: Props) {
  const { pathname } = useLocation()
  const [balance, setBalance] = useState<string | null>(null)

  const refreshBalance = () => {
    getBalance().then(b => setBalance(b.balance != null ? String(b.balance) : null)).catch(() => {})
  }

  useEffect(() => {
    refreshBalance()
    const interval = setInterval(refreshBalance, 30_000)
    return () => clearInterval(interval)
  }, [])

  const linkClass = (path: string) =>
    `px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
      pathname === path
        ? 'bg-accent/10 text-accent'
        : 'text-text-secondary hover:text-text-primary'
    }`

  return (
    <nav className="border-b border-card">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-1">
          <span className="text-accent font-semibold text-lg mr-4">Crypto Dashboard</span>
          <Link to="/signals" className={linkClass('/signals')}>Сигналы</Link>
          <Link to="/scanner" className={linkClass('/scanner')}>Сканер</Link>
          <Link to="/trades" className={linkClass('/trades')}>Сделки</Link>
          <Link to="/positions" className={linkClass('/positions')}>Позиции</Link>
          <Link to="/settings" className={linkClass('/settings')}>Настройки</Link>
        </div>
        <div className="flex items-center gap-3">
          {balance != null && (
            <span className="font-mono text-sm text-accent">{parseFloat(balance).toFixed(3)} USDT</span>
          )}
          <KillSwitchButton onActivated={refreshBalance} />
          {onLogout && (
            <button
              onClick={onLogout}
              className="px-3 py-1.5 rounded-lg text-sm text-text-secondary hover:text-short transition-colors"
            >
              Выйти
            </button>
          )}
        </div>
      </div>
    </nav>
  )
}
