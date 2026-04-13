/**
 * Sanitize a CSV field to prevent formula injection (CSV injection / DDE attack).
 * OWASP recommendation: prefix dangerous characters with a single quote.
 * Dangerous first characters: =, +, -, @, tab, carriage return
 */
export function sanitizeCsvField(value: string): string {
  if (!value) return value
  const firstChar = value.charAt(0)
  if (firstChar === '=' || firstChar === '+' || firstChar === '-' || firstChar === '@' || firstChar === '\t' || firstChar === '\r') {
    return "'" + value
  }
  return value
}
