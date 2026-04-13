import { useState, useEffect } from 'react'
import { getTickerMappings, createTickerMapping, deleteTickerMapping, TickerMapping } from '../../api/client'

interface TickerMappingsSectionProps {
  showToast: (message: string, type: 'success' | 'error') => void
}

export default function TickerMappingsSection({ showToast }: TickerMappingsSectionProps) {
  const [mappings, setMappings] = useState<TickerMapping[]>([])
  const [mappingsLoading, setMappingsLoading] = useState(true)
  const [newMapping, setNewMapping] = useState({ fromTicker: '', toSymbol: '', priceMultiplier: 1, notes: '' })
  const [showAddMapping, setShowAddMapping] = useState(false)

  useEffect(() => {
    getTickerMappings()
      .then(setMappings)
      .catch(() => {})
      .finally(() => setMappingsLoading(false))
  }, [])

  async function handleAddMapping() {
    if (!newMapping.fromTicker || !newMapping.toSymbol) {
      showToast('From and To fields are required', 'error')
      return
    }
    try {
      const created = await createTickerMapping(newMapping)
      setMappings(prev => [...prev, created])
      setNewMapping({ fromTicker: '', toSymbol: '', priceMultiplier: 1, notes: '' })
      setShowAddMapping(false)
      showToast('Mapping added', 'success')
    } catch (err: any) {
      showToast(err.message, 'error')
    }
  }

  async function handleDeleteMapping(id: number) {
    try {
      await deleteTickerMapping(id)
      setMappings(prev => prev.filter(m => m.id !== id))
      showToast('Mapping deleted', 'success')
    } catch (err: any) {
      showToast(err.message, 'error')
    }
  }

  return (
    <section className="bg-card rounded-xl p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-text-primary">Ticker Mappings</h2>
        <button
          type="button"
          onClick={() => setShowAddMapping(!showAddMapping)}
          className="text-sm font-medium text-accent hover:opacity-80"
        >
          {showAddMapping ? 'Cancel' : '+ Add Mapping'}
        </button>
      </div>

      <p className="text-sm text-text-secondary mb-4">
        Map signal tickers to Bybit symbols. For 1000x tickers (e.g. PEPE to 1000PEPEUSDT), set multiplier to 1000.
      </p>

      {/* Add form */}
      {showAddMapping && (
        <div className="bg-input rounded-lg p-4 mb-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-text-secondary block mb-1">From Ticker</label>
              <input
                type="text"
                value={newMapping.fromTicker}
                onChange={e => setNewMapping(prev => ({ ...prev, fromTicker: e.target.value.toUpperCase() }))}
                placeholder="PEPE"
                className="bg-primary border border-input rounded-lg px-3 py-2 text-sm text-text-primary w-full focus:border-accent focus:outline-none font-mono"
              />
            </div>
            <div>
              <label className="text-xs text-text-secondary block mb-1">To Symbol (Bybit)</label>
              <input
                type="text"
                value={newMapping.toSymbol}
                onChange={e => setNewMapping(prev => ({ ...prev, toSymbol: e.target.value.toUpperCase() }))}
                placeholder="1000PEPEUSDT"
                className="bg-primary border border-input rounded-lg px-3 py-2 text-sm text-text-primary w-full focus:border-accent focus:outline-none font-mono"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-text-secondary block mb-1">Price Multiplier</label>
              <input
                type="number"
                value={newMapping.priceMultiplier}
                onChange={e => setNewMapping(prev => ({ ...prev, priceMultiplier: Number(e.target.value) }))}
                className="bg-primary border border-input rounded-lg px-3 py-2 text-sm text-text-primary w-full focus:border-accent focus:outline-none font-mono"
              />
            </div>
            <div>
              <label className="text-xs text-text-secondary block mb-1">Notes</label>
              <input
                type="text"
                value={newMapping.notes}
                onChange={e => setNewMapping(prev => ({ ...prev, notes: e.target.value }))}
                placeholder="1000x bundle"
                className="bg-primary border border-input rounded-lg px-3 py-2 text-sm text-text-primary w-full focus:border-accent focus:outline-none"
              />
            </div>
          </div>
          <button
            type="button"
            onClick={handleAddMapping}
            className="bg-accent text-primary px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90"
          >
            Add Mapping
          </button>
        </div>
      )}

      {/* Mappings table */}
      {mappingsLoading ? (
        <div className="bg-input animate-pulse rounded-lg h-24" />
      ) : mappings.length === 0 ? (
        <p className="text-sm text-text-secondary text-center py-4">No mappings configured</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-secondary text-xs uppercase border-b border-input">
                <th className="py-2 text-left">From</th>
                <th className="py-2 text-left">To (Bybit)</th>
                <th className="py-2 text-right">Multiplier</th>
                <th className="py-2 text-left">Notes</th>
                <th className="py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {mappings.map(m => (
                <tr key={m.id} className="border-b border-input/50">
                  <td className="py-2 font-mono text-text-primary">{m.fromTicker}</td>
                  <td className="py-2 font-mono text-text-primary">{m.toSymbol}</td>
                  <td className="py-2 font-mono text-text-primary text-right">{m.priceMultiplier}x</td>
                  <td className="py-2 text-text-secondary">{m.notes || '-'}</td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      onClick={() => handleDeleteMapping(m.id)}
                      className="text-short hover:opacity-80 text-xs"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
