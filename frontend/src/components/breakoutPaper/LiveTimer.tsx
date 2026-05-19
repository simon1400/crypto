import { useState, useEffect } from 'react'
import { formatElapsed } from './helpers'

/** Live-updating elapsed-since-open. Re-renders every 60s while mounted. */
export default function LiveTimer({ openedAt }: { openedAt: string }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60000)
    return () => clearInterval(id)
  }, [])
  return <>{formatElapsed(openedAt)}</>
}
