import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { useState, useEffect } from 'react'
import Navbar from './components/Navbar'
import Signals from './pages/Signals'
import Trades from './pages/Trades'
import Scanner from './pages/Scanner'
import Login from './pages/Login'
import { setAuthToken } from './api/client'

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
      <div className="min-h-screen">
        <Navbar onLogout={handleLogout} />
        <main className="max-w-7xl mx-auto px-4 py-6">
          <Routes>
            <Route path="/" element={<Signals />} />
            <Route path="/signals" element={<Signals />} />
            <Route path="/trades" element={<Trades />} />
            <Route path="/scanner" element={<Scanner />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
