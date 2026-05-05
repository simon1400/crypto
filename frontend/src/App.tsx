import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { useState, useEffect } from 'react'
import Navbar from './components/Navbar'
import Signals from './pages/Signals'
import Trades from './pages/Trades'
import Scanner from './pages/Scanner'
import ScannerForex from './pages/ScannerForex'
import TradesForex from './pages/TradesForex'
import Settings from './pages/Settings'
import Calculator from './pages/Calculator'
import Levels from './pages/Levels'
import LevelsPaper from './pages/LevelsPaper'
import Login from './pages/Login'
import { setAuthToken } from './api/client'
import { BalanceProvider } from './contexts/BalanceContext'

function AppLayout({ onLogout }: { onLogout: () => void }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar onLogout={onLogout} />
      <main className="max-w-7xl mx-auto px-4 py-6 w-full">
        <Routes>
          <Route path="/" element={<Signals />} />
          <Route path="/signals" element={<Signals />} />
          <Route path="/trades" element={<Trades />} />
          <Route path="/scanner" element={<Scanner />} />
          <Route path="/scanner-forex" element={<ScannerForex />} />
          <Route path="/trades-forex" element={<TradesForex />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/calculator" element={<Calculator />} />
          <Route path="/levels" element={<Levels />} />
          <Route path="/levels-paper" element={<LevelsPaper />} />
        </Routes>
      </main>
    </div>
  )
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('auth_token'))

  useEffect(() => {
    if (token) setAuthToken(token)
  }, [token])

  function handleLogin(t: string) {
    localStorage.setItem('auth_token', t)
    setAuthToken(t)
    setToken(t)
  }

  function handleLogout() {
    localStorage.removeItem('auth_token')
    setAuthToken('')
    setToken(null)
  }

  if (!token) {
    return <Login onLogin={handleLogin} />
  }

  return (
    <BrowserRouter>
      <BalanceProvider>
        <AppLayout onLogout={handleLogout} />
      </BalanceProvider>
    </BrowserRouter>
  )
}
