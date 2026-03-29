import { Link, useLocation } from 'react-router-dom'

interface Props {
  onLogout?: () => void
}

export default function Navbar({ onLogout }: Props) {
  const { pathname } = useLocation()

  const linkClass = (path: string) =>
    `px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
      pathname === path
        ? 'bg-accent/10 text-accent'
        : 'text-text-secondary hover:text-text-primary'
    }`

  return (
    <nav className="border-b border-card">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
        <span className="text-accent font-semibold text-lg">Crypto Dashboard</span>
        <div className="flex items-center gap-1">
          <Link to="/" className={linkClass('/')}>Анализ</Link>
          <Link to="/whales" className={linkClass('/whales')}>Киты</Link>
          <Link to="/signals" className={linkClass('/signals')}>Сигналы</Link>
          <Link to="/history" className={linkClass('/history')}>История</Link>
          {onLogout && (
            <button
              onClick={onLogout}
              className="ml-3 px-3 py-1.5 rounded-lg text-sm text-text-secondary hover:text-short transition-colors"
            >
              Выйти
            </button>
          )}
        </div>
      </div>
    </nav>
  )
}
