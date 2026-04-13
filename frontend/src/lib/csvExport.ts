import { sanitizeCsvField } from '../utils/sanitizeCsv'

export function escapeCsvField(value: string | number): string {
  const s = String(value)
  return `"${sanitizeCsvField(s).replace(/"/g, '""')}"`
}

export function downloadCsv(options: {
  header: string[]
  rows: (string | number)[][]
  filename: string
  separator?: string
}): void {
  const sep = options.separator ?? ','
  const esc = escapeCsvField
  const headerLine = options.header.map(h => esc(h)).join(sep)
  const dataLines = options.rows.map(r => r.map(v => esc(v)).join(sep))
  const csv = '\uFEFF' + [headerLine, ...dataLines].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = options.filename
  a.click()
  URL.revokeObjectURL(url)
}
