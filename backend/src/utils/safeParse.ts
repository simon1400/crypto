export function safeParse<T>(raw: string, fallback: T, label = 'safeParse'): T {
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    console.warn(`[${label}] Failed to parse JSON, using fallback:`, err)
    return fallback
  }
}
