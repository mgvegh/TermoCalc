import type { OutputKey } from './thermoEngine'

const DECIMALS: Partial<Record<OutputKey, number>> = { P: 3, T: 3, u: 3, h: 3, s: 5, x: 4 }

/** Formatea un valor para mostrar/copiar (punto decimal, sin separador de miles). */
export function formatValue(key: OutputKey, value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (key === 'v' || key === 'rho') {
    const abs = Math.abs(value)
    if (abs !== 0 && (abs < 1e-4 || abs >= 1e6)) return value.toExponential(5)
    return Number(value.toPrecision(6)).toString()
  }
  const d = DECIMALS[key] ?? 4
  const out = value.toFixed(d)
  return out === `-${(0).toFixed(d)}` ? (0).toFixed(d) : out
}

/** Convierte texto de un input (admite coma decimal) a número. */
export function parseInput(text: string): number {
  const t = text.trim().replace(',', '.')
  if (t === '' || t === '-' || t === '.') return NaN
  return Number(t)
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  }
}
