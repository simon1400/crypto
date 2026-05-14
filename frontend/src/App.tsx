import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import Navbar from './components/Navbar'
import Settings from './pages/Settings'
import Calculator from './pages/Calculator'
import BreakoutPage from './pages/BreakoutPage'
import BinaryHelper from './pages/BinaryHelper'
import Login from './pages/Login'
import { setAuthToken } from './api/client'
import { BalanceProvider } from './contexts/BalanceContext'

function AppLayout({ onLogout }: { onLogout: () => void }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar onLogout={onLogout} />
      <main className="max-w-7xl mx-auto px-4 pt-2 pb-6 sm:py-6 w-full">
        <Routes>
          <Route path="/" element={<Navigate to="/breakout" replace />} />
          <Route path="/breakout" element={<BreakoutPage />} />
          <Route path="/binary" element={<BinaryHelper />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/calculator" element={<Calculator />} />
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
