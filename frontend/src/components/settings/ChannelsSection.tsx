const NEAR512_TOPICS = [
  { key: 'Near512-LowCap', label: 'Low Cap' },
  { key: 'Near512-MidHigh', label: 'Mid/High Cap' },
  { key: 'Near512-Spot', label: 'Spot' },
]

const EVENING_TRADER_CATEGORIES = [
  { key: 'scalp', label: 'Scalp' },
  { key: 'risk-scalp', label: 'Risk Scalp' },
  { key: 'swing', label: 'Swing' },
]

interface ChannelsSectionProps {
  near512Topics: string[]
  setNear512Topics: (v: string[]) => void
  eveningTraderCategories: string[]
  setEveningTraderCategories: (v: string[]) => void
}

export default function ChannelsSection({
  near512Topics,
  setNear512Topics,
  eveningTraderCategories,
  setEveningTraderCategories,
}: ChannelsSectionProps) {
  function toggleTopic(key: string) {
    setNear512Topics(
      near512Topics.includes(key)
        ? near512Topics.filter((k) => k !== key)
        : [...near512Topics, key]
    )
  }

  function toggleCategory(key: string) {
    setEveningTraderCategories(
      eveningTraderCategories.includes(key)
        ? eveningTraderCategories.filter((k) => k !== key)
        : [...eveningTraderCategories, key]
    )
  }

  return (
    <section className="bg-card rounded-xl p-6">
      <h2 className="text-lg font-semibold text-text-primary mb-6">Channels</h2>

      <div className="space-y-6">
        {/* Near512 Topics */}
        <div>
          <h3 className="text-sm font-medium text-text-secondary uppercase tracking-wide mb-3">
            Near512 Topics
          </h3>
          <div className="space-y-3">
            {NEAR512_TOPICS.map((topic) => (
              <label key={topic.key} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={near512Topics.includes(topic.key)}
                  onChange={() => toggleTopic(topic.key)}
                  className="w-[18px] h-[18px] rounded border-2 border-neutral bg-transparent checked:bg-accent checked:border-accent accent-accent cursor-pointer"
                />
                <span className="text-sm text-text-primary">{topic.label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* EveningTrader Categories */}
        <div>
          <h3 className="text-sm font-medium text-text-secondary uppercase tracking-wide mb-3">
            EveningTrader Categories
          </h3>
          <div className="space-y-3">
            {EVENING_TRADER_CATEGORIES.map((cat) => (
              <label key={cat.key} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={eveningTraderCategories.includes(cat.key)}
                  onChange={() => toggleCategory(cat.key)}
                  className="w-[18px] h-[18px] rounded border-2 border-neutral bg-transparent checked:bg-accent checked:border-accent accent-accent cursor-pointer"
                />
                <span className="text-sm text-text-primary">{cat.label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
