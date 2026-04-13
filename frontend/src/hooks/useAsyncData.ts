import { useState, useEffect, useCallback, useRef } from 'react'

export function useAsyncData<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: unknown[] = []
): {
  data: T | null
  loading: boolean
  error: string | null
  refetch: () => void
  abort: () => void
} {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const execute = useCallback(async () => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setLoading(true)
    setError(null)
    try {
      const result = await fetcherRef.current(ctrl.signal)
      if (!ctrl.signal.aborted) {
        setData(result)
        setLoading(false)
      }
    } catch (err: any) {
      if (err instanceof Error && err.name === 'AbortError') return
      setError(err instanceof Error ? err.message : 'Unknown error')
      setLoading(false)
    }
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    execute()
    return () => { abortRef.current?.abort() }
  }, deps)

  const refetch = useCallback(() => { execute() }, [execute])
  const abort = useCallback(() => { abortRef.current?.abort() }, [])

  return { data, loading, error, refetch, abort }
}
