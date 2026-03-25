import { useState, FormEvent } from 'react'

interface Props {
  onLogin: (token: string) => void
}

export default function Login({ onLogin }: Props) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const BASE = import.meta.env.VITE_API_URL || ''

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const res = await fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })

      if (!res.ok) {
        setError('Неверный пароль')
        return
      }

      const data = await res.json()
      onLogin(data.token)
    } catch {
      setError('Ошибка подключения')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <form onSubmit={handleSubmit} className="bg-card rounded-xl p-8 w-full max-w-sm border border-card">
        <h1 className="text-2xl font-bold text-accent mb-6 text-center">Crypto Dashboard</h1>

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Пароль"
          className="w-full bg-input rounded-lg px-4 py-3 text-text-primary placeholder-text-secondary outline-none border border-transparent focus:border-accent/50 mb-4"
          autoFocus
        />

        {error && <p className="text-short text-sm mb-4">{error}</p>}

        <button
          type="submit"
          disabled={loading || !password}
          className="w-full bg-accent text-bg-primary font-bold py-3 rounded-lg hover:brightness-110 transition disabled:opacity-50"
        >
          {loading ? 'Вход...' : 'Войти'}
        </button>
      </form>
    </div>
  )
}
