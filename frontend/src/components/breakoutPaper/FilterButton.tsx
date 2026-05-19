export default function FilterButton({ active, onClick, children }: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button onClick={onClick}
      className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
        active ? 'bg-accent text-bg-primary' : 'bg-card border border-input text-text-secondary hover:text-text-primary'
      }`}>
      {children}
    </button>
  )
}
