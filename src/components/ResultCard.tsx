import { useState } from 'react'
import { PROPERTY_META, type OutputKey, type Phase, type ThermoState } from '../utils/thermoEngine'
import { copyToClipboard, formatValue } from '../utils/format'
import { CheckIcon, CopyIcon } from './Icons'

const PHASE_STYLE: Record<Phase, string> = {
  'Líquido subenfriado': 'bg-blue-500/15 text-blue-300 ring-blue-500/40',
  'Líquido saturado': 'bg-cyan-500/15 text-cyan-300 ring-cyan-500/40',
  'Mezcla líquido-vapor': 'bg-violet-500/15 text-violet-300 ring-violet-500/40',
  'Vapor saturado': 'bg-amber-500/15 text-amber-300 ring-amber-500/40',
  'Vapor sobrecalentado': 'bg-orange-500/15 text-orange-300 ring-orange-500/40',
  'Fluido supercrítico': 'bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/40',
  'Gas ideal': 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40',
}

const ROWS: OutputKey[] = ['P', 'T', 'v', 'u', 'h', 's', 'x', 'rho']

function ResultRow({ k, value }: { k: OutputKey; value: number }) {
  const [copied, setCopied] = useState(false)
  const meta = PROPERTY_META[k]
  const text = formatValue(k, value)

  const copy = async () => {
    if (await copyToClipboard(text)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    }
  }

  return (
    <li className="flex items-center gap-3 py-2.5">
      <span className="w-7 text-center font-serif text-xl italic text-cyan-400">{meta.symbol}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] uppercase tracking-wide text-slate-500">{meta.label}</div>
        <div className="truncate text-lg font-semibold tabular-nums text-white">
          {text} <span className="text-sm font-normal text-slate-400">{meta.unit}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copiar ${meta.label}`}
        className={`flex h-9 w-9 items-center justify-center rounded-lg border transition active:scale-90 ${
          copied
            ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
            : 'border-slate-700 bg-slate-800 text-slate-300 hover:text-white'
        }`}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </li>
  )
}

export default function ResultCard({ state }: { state: ThermoState }) {
  const rows = ROWS.filter((k) => k !== 'x' || state.x !== null)
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 shadow-lg shadow-black/20">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Resultados</h2>
        <span className={`rounded-full px-3 py-1 text-xs font-bold ring-1 ${PHASE_STYLE[state.phase]}`}>
          {state.phase}
        </span>
      </div>
      <ul className="divide-y divide-slate-800">
        {rows.map((k) => (
          <ResultRow key={k} k={k} value={k === 'x' ? (state.x as number) : state[k]} />
        ))}
      </ul>
    </section>
  )
}
