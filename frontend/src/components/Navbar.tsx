import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { getBudget, BudgetStatus } from '../api/client'
import KillSwitchButton from './KillSwitchButton'

interface Props {
  onLogout?: () => void
}

export default function Navbar({ onLogout }: Props) {
  const { pathname } = useLocation()
  const [budget, setBudget] = useState<BudgetStatus | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const refreshBalance = () => {
    getBudget().then(setBudget).catch(() => {})
  }

  useEffect(() => {
    refreshBalance()
    const interval = setInterval(refreshBalance, 15_000)
    return () => clearInterval(interval)
  }, [])

  // Close menu on route change
  useEffect(() => {
    setMenuOpen(false)
  }, [pathname])

  const linkClass = (path: string) =>
    `px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
      pathname === path
        ? 'bg-accent/10 text-accent'
        : 'text-text-secondary hover:text-text-primary'
    }`

  return (
    <nav className="border-b border-card relative">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
        {/* Logo */}
        <span className="text-accent font-semibold text-lg shrink-0">Crypto Dashboard</span>

        {/* Desktop nav links */}
        <div className="hidden lg:flex items-center gap-1">
          <Link to="/signals" className={linkClass('/signals')}>Сигналы</Link>
          <Link to="/scanner" className={linkClass('/scanner')}>Сканер</Link>
          <Link to="/trades" className={linkClass('/trades')}>Сделки</Link>
          <Link to="/positions" className={linkClass('/positions')}>Позиции</Link>
          <Link to="/settings" className={linkClass('/settings')}>Настройки</Link>
          <Link to="/backtester" className={linkClass('/backtester')}>Бэктестер</Link>
        </div>

        {/* Right side: balance, kill switch, logout, burger */}
        <div className="flex items-center gap-2 sm:gap-3">
          {budget != null && (
            <div
              className="font-mono text-xs sm:text-sm flex flex-col items-end leading-tight"
              title={
                `Виртуальный депозит: ${budget.balance.toFixed(2)} USDT\n` +
                `Старт: ${budget.start.toFixed(2)} USDT\n` +
                `P&L: ${budget.pnl >= 0 ? '+' : ''}${budget.pnl.toFixed(2)} USDT (${budget.roiPct >= 0 ? '+' : ''}${budget.roiPct.toFixed(2)}%)\n` +
                `Занято маржой: ${budget.used.toFixed(2)} USDT\n` +
                `Свободно: ${budget.available.toFixed(2)} USDT`
              }
            >
              <div className="flex items-baseline gap-2">
                <span className="text-accent">{budget.balance.toFixed(2)} USDT</span>
                {budget.start > 0 && (
                  <span className={`text-[10px] ${budget.pnl >= 0 ? 'text-long' : 'text-short'}`}>
                    {budget.roiPct >= 0 ? '+' : ''}{budget.roiPct.toFixed(2)}%
                  </span>
                )}
              </div>
              <span className={
                budget.available < 0
                  ? 'text-short text-[10px]'
                  : budget.available < budget.balance * 0.1
                    ? 'text-accent text-[10px]'
                    : 'text-text-secondary text-[10px]'
              }>
                свободно {budget.available.toFixed(2)}
              </span>
            </div>
          )}
          <KillSwitchButton onActivated={refreshBalance} />
          {onLogout && (
            <button
              onClick={onLogout}
              className="hidden sm:block px-3 py-1.5 rounded-lg text-sm text-text-secondary hover:text-short transition-colors"
            >
              Выйти
            </button>
          )}

          {/* Burger button — mobile/tablet */}
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="lg:hidden p-2 text-text-secondary hover:text-text-primary transition-colors"
            aria-label="Menu"
          >
            {menuOpen ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Mobile menu dropdown */}
      {menuOpen && (
        <div className="lg:hidden absolute top-14 left-0 right-0 bg-primary border-b border-card z-50 shadow-lg shadow-black/30">
          <div className="flex flex-col p-3 gap-1">
            <Link to="/signals" className={linkClass('/signals')}>Сигналы</Link>
            <Link to="/scanner" className={linkClass('/scanner')}>Сканер</Link>
            <Link to="/trades" className={linkClass('/trades')}>Сделки</Link>
            <Link to="/positions" className={linkClass('/positions')}>Позиции</Link>
            <Link to="/settings" className={linkClass('/settings')}>Настройки</Link>
            <Link to="/backtester" className={linkClass('/backtester')}>Бэктестер</Link>
            {onLogout && (
              <button
                onClick={onLogout}
                className="sm:hidden px-4 py-2 rounded-lg text-sm font-medium text-text-secondary hover:text-short text-left transition-colors"
              >
                Выйти
              </button>
            )}
          </div>
        </div>
      )}
    </nav>
  )
}
