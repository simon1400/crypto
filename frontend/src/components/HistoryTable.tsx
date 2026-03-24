import { Analysis } from '../api/client'

interface Props {
  data: Analysis[]
  onView: (analysis: Analysis) => void
}

export default function HistoryTable({ data, onView }: Props) {
  if (data.length === 0) {
    return <p className="text-text-secondary text-center py-10">Нет записей</p>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-card text-text-secondary text-left">
            <th className="py-3 px-4">Дата / Время</th>
            <th className="py-3 px-4">Монеты</th>
            <th className="py-3 px-4 text-right">Действие</th>
          </tr>
        </thead>
        <tbody>
          {data.map((item) => (
            <tr key={item.id} className="border-b border-card/50 hover:bg-card/50 transition-colors">
              <td className="py-3 px-4 font-mono text-xs">
                {new Date(item.createdAt).toLocaleString('ru-RU')}
              </td>
              <td className="py-3 px-4">
                <div className="flex gap-1 flex-wrap">
                  {item.coins.split(',').map((c) => (
                    <span key={c} className="bg-accent/10 text-accent px-2 py-0.5 rounded text-xs">
                      {c}
                    </span>
                  ))}
                </div>
              </td>
              <td className="py-3 px-4 text-right">
                <button
                  onClick={() => onView(item)}
                  className="text-accent hover:text-accent/80 text-sm font-medium transition-colors"
                >
                  Смотреть
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
