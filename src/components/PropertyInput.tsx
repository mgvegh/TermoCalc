import { PROPERTY_META, type PropKey } from '../utils/thermoEngine'
import { ChevronIcon } from './Icons'

interface Props {
  index: 1 | 2
  prop: PropKey
  options: PropKey[]
  value: string
  onPropChange: (p: PropKey) => void
  onValueChange: (v: string) => void
}

const CAN_BE_NEGATIVE: PropKey[] = ['T', 'h', 's']

export default function PropertyInput({ index, prop, options, value, onPropChange, onValueChange }: Props) {
  const meta = PROPERTY_META[prop]
  const inputId = `prop-${index}-value`

  const toggleSign = () => {
    const v = value.trim()
    onValueChange(v.startsWith('-') ? v.slice(1) : `-${v}`)
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-3 shadow-lg shadow-black/20">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Propiedad {index}</span>
        <div className="relative">
          <select
            aria-label={`Propiedad ${index}`}
            value={prop}
            onChange={(e) => onPropChange(e.target.value as PropKey)}
            style={{ WebkitAppearance: 'none', MozAppearance: 'none', appearance: 'none', backgroundImage: 'none' }}
            className="appearance-none rounded-lg border border-slate-700 bg-slate-800 py-1.5 pl-3 pr-8 text-sm font-medium text-slate-100 outline-none focus:border-cyan-500"
          >
            {options.map((k) => (
              <option key={k} value={k}>
                {PROPERTY_META[k].symbol} — {PROPERTY_META[k].label}
              </option>
            ))}
          </select>
          <ChevronIcon className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        </div>
      </div>

      <div className="flex items-stretch gap-2">
        <label htmlFor={inputId} className="flex w-10 items-center justify-center font-serif text-2xl italic text-cyan-400">
          {meta.symbol}
        </label>
        <div className="flex min-w-0 flex-1 items-center rounded-xl border border-slate-700 bg-slate-950 focus-within:border-cyan-500 focus-within:ring-2 focus-within:ring-cyan-500/20">
          <input
            id={inputId}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder="0"
            className="min-w-0 flex-1 bg-transparent px-3 py-3 text-lg font-semibold tabular-nums text-white outline-none placeholder:text-slate-600"
          />
          <span className="whitespace-nowrap pr-3 text-sm font-medium text-slate-400">{meta.unit}</span>
        </div>
        {CAN_BE_NEGATIVE.includes(prop) && (
          <button
            type="button"
            onClick={toggleSign}
            aria-label="Cambiar signo"
            className="w-11 shrink-0 rounded-xl border border-slate-700 bg-slate-800 text-lg font-bold text-slate-300 active:scale-95 active:bg-slate-700"
          >
            ±
          </button>
        )}
      </div>
    </div>
  )
}
