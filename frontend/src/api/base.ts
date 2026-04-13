export const BASE = import.meta.env.VITE_API_URL || ''

let authToken = localStorage.getItem('auth_token') || ''

export function setAuthToken(token: string) {
  authToken = token
}

export function getHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Api-Secret': authToken,
  }
}
