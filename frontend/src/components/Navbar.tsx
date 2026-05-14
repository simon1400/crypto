import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useBalance } from '../contexts/BalanceContext'

interface Props {
  onLogout?: () => void
}

export default function Navbar({ onLogout }: Props) {
  const { pathname } = useLocation()
  const { balances } = useBalance()
  const [menuOpen, setMenuOpen] = useState(false)

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
        {/* Desktop nav links — aligned left */}
        <div className="hidden lg:flex items-center gap-1">
          <Link to="/breakout" className={linkClass('/breakout')}>Breakout</Link>
          <Link to="/binary" className={linkClass('/binary')}>Binary</Link>
          <Link to="/calculator" className={linkClass('/calculator')}>Калькулятор</Link>
          <Link to="/settings" className={linkClass('/settings')}>Настройки</Link>
        </div>

        {/* Right side: per-variant balances, logout, burger */}
        <div className="flex items-center gap-2 sm:gap-3 ml-auto flex-1 min-w-0">
          {balances && balances.length > 0 && (
            <div
              className="flex flex-1 items-center gap-1 sm:gap-2 font-mono min-w-0"
              style={{ containerType: 'inline-size' }}
            >
              {balances.map(b => (
                <div
                  key={b.variant}
                  className="flex flex-1 items-baseline justify-center gap-1 sm:gap-1.5 px-1.5 sm:px-2 py-1 rounded-md bg-card/60 border border-card min-w-0 whitespace-nowrap"
                  style={{ fontSize: 'clamp(10px, 4cqi, 14px)' }}
                  title={
                    `Вариант ${b.variant}\n` +
                    `Текущий: ${b.balance.toFixed(2)} USDT\n` +
                    `Старт: ${b.start.toFixed(2)} USDT\n` +
                    `P&L: ${b.pnl >= 0 ? '+' : ''}${b.pnl.toFixed(2)} USDT (${b.roiPct >= 0 ? '+' : ''}${b.roiPct.toFixed(2)}%)`
                  }
                >
                  <span className="text-text-secondary">{b.variant}</span>
                  <span className="text-accent">{b.balance.toFixed(0)}</span>
                  {b.start > 0 && (
                    <span
                      className={b.pnl >= 0 ? 'text-long' : 'text-short'}
                      style={{ fontSize: '0.85em' }}
                    >
                      {b.roiPct >= 0 ? '+' : ''}{b.roiPct.toFixed(1)}%
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
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
            <Link to="/breakout" className={linkClass('/breakout')}>Breakout</Link>
            <Link to="/calculator" className={linkClass('/calculator')}>Калькулятор</Link>
            <Link to="/settings" className={linkClass('/settings')}>Настройки</Link>
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
