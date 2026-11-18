import { useMemo, useRef, useState } from 'react'
import { AlertIcon, CheckIcon, CopyIcon, SwapIcon } from './components/Icons'
import { copyToClipboard, formatValue, parseInput } from './utils/format'
import {
  FLUIDS,
  PROPERTY_META,
  computeState,
  getFluidProps,
  getPairOptions,
  type Fluid,
  type OutputKey,
  type PropKey,
  type ThermoState,
} from './utils/thermoEngine'

const DEFAULTS: Record<Fluid, Partial<Record<PropKey, string>>> = {
  water: { P: '1', T: '150', v: '1.5', h: '2500', s: '7', x: '0.5' },
  r134a: { P: '8', T: '50', v: '0.03', h: '280', s: '1', x: '0.5' },
  air: { P: '1', T: '31.85', v: '0.8754', h: '306.5', s: '0.1108' },
}

const CAN_BE_NEGATIVE: PropKey[] = ['T', 'h', 's']
const RESULT_KEYS: OutputKey[] = ['P', 'T', 'v', 'u', 'h', 's', 'x']

const DOME_TEMPS: Record<'water' | 'r134a', number[]> = {
  water: [0.01, 10, 25, 50, 75, 100, 125, 150, 175, 200, 225, 250, 275, 300, 325, 340, 350],
  r134a: [-100, -80, -60, -40, -20, 0, 20, 40, 60, 75, 85, 92, 97, 100, 100.8],
}

type DiagramType = 'Ts' | 'Ph' | 'Pv'

interface SavedState extends ThermoState {
  id: number
}

interface Selection {
  p1: PropKey
  p2: PropKey
  v1: string
  v2: string
}

const initialSelection = (fluid: Fluid): Selection => ({
  p1: 'P',
  p2: 'T',
  v1: DEFAULTS[fluid].P ?? '',
  v2: DEFAULTS[fluid].T ?? '',
})

function buildDome(fluid: Fluid): ThermoState[] {
  if (fluid === 'air') return []
  const liq: ThermoState[] = []
  const vap: ThermoState[] = []
  for (const T of DOME_TEMPS[fluid]) {
    const r0 = computeState(fluid, 'T', T, 'x', 0)
    const r1 = computeState(fluid, 'T', T, 'x', 1)
    if (r0.ok) liq.push(r0.state)
    if (r1.ok) vap.push(r1.state)
  }
  return [...liq, ...vap.reverse()]
}

function CycleChart({
  fluid,
  states,
  diagram,
  closeCycle,
  zoom,
  pan,
  onPan,
  onZoom,
}: {
  fluid: Fluid
  states: SavedState[]
  diagram: DiagramType
  closeCycle: boolean
  zoom: number
  pan: { x: number; y: number }
  onPan: (dx: number, dy: number) => void
  onZoom: (factor: number) => void
}) {
  const dome = useMemo(() => buildDome(fluid), [fluid])
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragRef = useRef<{ x: number; y: number } | null>(null)

  const W = 360
  const H = 210
  const pad = { l: 48, r: 14, t: 14, b: 26 }
  const pw = W - pad.l - pad.r
  const ph = H - pad.t - pad.b

  const getXY = (st: ThermoState): [number, number] => {
    if (diagram === 'Ts') return [st.s, st.T]
    if (diagram === 'Ph') return [st.h, Math.log10(Math.max(st.P, 1e-3))]
    return [st.v, Math.log10(Math.max(st.P, 1e-3))]
  }

  const domeXY = dome.map(getXY)
  const stateXY = states.map(getXY)
  const all = [...domeXY, ...stateXY]

  let baseXMin = Math.min(...all.map((p) => p[0]))
  let baseXMax = Math.max(...all.map((p) => p[0]))
  let baseYMin = Math.min(...all.map((p) => p[1]))
  let baseYMax = Math.max(...all.map((p) => p[1]))

  if (!Number.isFinite(baseXMin) || !Number.isFinite(baseYMin)) {
    baseXMin = 0
    baseXMax = 1
    baseYMin = 0
    baseYMax = 1
  }

  const dx0 = baseXMax - baseXMin || Math.abs(baseXMin) * 0.2 || 1
  const dy0 = baseYMax - baseYMin || Math.abs(baseYMin) * 0.2 || 1
  baseXMin -= dx0 * 0.08
  baseXMax += dx0 * 0.08
  baseYMin -= dy0 * 0.08
  baseYMax += dy0 * 0.08

  // Ancla el zoom en el centroide de los estados del ciclo (si existen)
  const anchorX =
    stateXY.length > 0 ? stateXY.reduce((acc, p) => acc + p[0], 0) / stateXY.length : (baseXMin + baseXMax) / 2
  const anchorY =
    stateXY.length > 0 ? stateXY.reduce((acc, p) => acc + p[1], 0) / stateXY.length : (baseYMin + baseYMax) / 2

  const xMin = anchorX - (anchorX - baseXMin) / zoom + pan.x * (baseXMax - baseXMin)
  const xMax = anchorX + (baseXMax - anchorX) / zoom + pan.x * (baseXMax - baseXMin)
  const yMin = anchorY - (anchorY - baseYMin) / zoom + pan.y * (baseYMax - baseYMin)
  const yMax = anchorY + (baseYMax - anchorY) / zoom + pan.y * (baseYMax - baseYMin)

  const sx = (x: number) => pad.l + ((x - xMin) / (xMax - xMin)) * pw
  const sy = (y: number) => pad.t + ph - ((y - yMin) / (yMax - yMin)) * ph

  const toPoints = (pts: [number, number][]) => pts.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' ')

  const cyclePts =
    closeCycle && stateXY.length >= 2 ? toPoints([...stateXY, stateXY[0]]) : toPoints(stateXY)

  const fmtTick = (val: number, isLogY: boolean) => {
    const real = isLogY ? 10 ** val : val
    if (real >= 10000 || (real > 0 && real < 0.01)) return real.toExponential(0)
    if (Math.abs(real) >= 100) return real.toFixed(0)
    if (Math.abs(real) >= 10) return real.toFixed(1)
    return real.toFixed(2)
  }

  const isLogY = diagram !== 'Ts'
  const ySpan = yMax - yMin
  const xSpan = xMax - xMin
  const yTicks = [yMin + ySpan * 0.12, (yMin + yMax) / 2, yMax - ySpan * 0.12]
  const xTicks = [xMin + xSpan * 0.12, (xMin + xMax) / 2, xMax - xSpan * 0.12]
  const xLabel = diagram === 'Ts' ? 's [kJ/kg·K]' : diagram === 'Ph' ? 'h [kJ/kg]' : 'v [m³/kg]'
  const yLabel = diagram === 'Ts' ? 'T [°C]' : 'P [bar]'

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, y: e.clientY }
  }

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragRef.current || !svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const scaleX = W / rect.width
    const scaleY = H / rect.height
    const dPxX = (e.clientX - dragRef.current.x) * scaleX
    const dPxY = (e.clientY - dragRef.current.y) * scaleY
    dragRef.current = { x: e.clientX, y: e.clientY }
    onPan(-(dPxX / pw) / zoom, (dPxY / ph) / zoom)
  }

  const handlePointerUp = () => {
    dragRef.current = null
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onWheel={(e) => {
        e.preventDefault()
        onZoom(e.deltaY < 0 ? 1.25 : 0.8)
      }}
      className="w-full touch-none select-none cursor-grab active:cursor-grabbing"
    >
      <defs>
        <clipPath id="plot-clip">
          <rect x={pad.l} y={pad.t} width={pw} height={ph} />
        </clipPath>
      </defs>

      {/* Grilla sutil */}
      {yTicks.map((t, i) => (
        <g key={`y-${i}`}>
          <line x1={pad.l} y1={sy(t)} x2={W - pad.r} y2={sy(t)} className="stroke-zinc-800" strokeWidth={1} />
          <text x={pad.l - 5} y={sy(t) + 3} textAnchor="end" className="fill-zinc-500 font-mono text-[9px]">
            {fmtTick(t, isLogY)}
          </text>
        </g>
      ))}
      {xTicks.map((t, i) => (
        <g key={`x-${i}`}>
          <line x1={sx(t)} y1={pad.t} x2={sx(t)} y2={H - pad.b} className="stroke-zinc-800" strokeWidth={1} />
          <text x={sx(t)} y={H - pad.b + 11} textAnchor="middle" className="fill-zinc-500 font-mono text-[9px]">
            {fmtTick(t, false)}
          </text>
        </g>
      ))}

      {/* Marco de ejes */}
      <rect x={pad.l} y={pad.t} width={pw} height={ph} fill="none" className="stroke-zinc-800" strokeWidth={1} />
      <text x={pad.l + 4} y={pad.t + 10} className="fill-zinc-500 font-mono text-[9px]">
        {yLabel}
      </text>
      <text x={W - pad.r} y={H - 3} textAnchor="end" className="fill-zinc-500 font-mono text-[9px]">
        {xLabel}
      </text>

      {/* Área recortada del gráfico */}
      <g clipPath="url(#plot-clip)">
        {domeXY.length > 0 && (
          <polyline points={toPoints(domeXY)} fill="none" className="stroke-zinc-700" strokeWidth={1.5} />
        )}

        {stateXY.length >= 2 && (
          <polyline
            points={cyclePts}
            fill="none"
            className="stroke-sky-400"
            strokeWidth={1.75}
            strokeLinejoin="round"
          />
        )}

        {stateXY.map(([x, y], i) => (
          <g key={states[i].id}>
            <circle
              cx={sx(x)}
              cy={sy(y)}
              r={8}
              className="fill-zinc-950 stroke-sky-400"
              strokeWidth={1.5}
            />
            <text
              x={sx(x)}
              y={sy(y) + 3}
              textAnchor="middle"
              className="fill-sky-400 font-mono text-[9px] font-bold"
            >
              {i + 1}
            </text>
          </g>
        ))}
      </g>
    </svg>
  )
}

export default function App() {
  const [fluid, setFluid] = useState<Fluid>('water')
  const [sel, setSel] = useState<Selection>(() => initialSelection('water'))
  const [airRef, setAirRef] = useState({ T0: '0', P0: '1' })
  const [copiedKey, setCopiedKey] = useState<OutputKey | null>(null)

  const [cycle, setCycle] = useState<SavedState[]>([])
  const [nextId, setNextId] = useState(1)
  const [closeCycle, setCloseCycle] = useState(true)
  const [diagram, setDiagram] = useState<DiagramType>('Ts')
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })

  const resetView = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }
  const adjustZoom = (factor: number) => setZoom((z) => Math.min(25, Math.max(0.5, z * factor)))

  const options1 = getFluidProps(fluid)
  const options2 = getPairOptions(fluid, sel.p1)

  const result = useMemo(
    () =>
      computeState(fluid, sel.p1, parseInput(sel.v1), sel.p2, parseInput(sel.v2), {
        T0: parseInput(airRef.T0),
        P0: parseInput(airRef.P0),
      }),
    [fluid, sel, airRef],
  )

  const activeDiagram: DiagramType = fluid === 'air' && diagram === 'Ph' ? 'Pv' : fluid !== 'air' && diagram === 'Pv' ? 'Ph' : diagram

  const changeFluid = (f: Fluid) => {
    if (f === fluid) return
    setFluid(f)
    setSel(initialSelection(f))
    resetView()
  }

  const changeP1 = (p1: PropKey) =>
    setSel((s) => {
      const opts = getPairOptions(fluid, p1)
      const p2 = opts.includes(s.p2) ? s.p2 : opts[0]
      return {
        p1,
        p2,
        v1: p1 === s.p2 ? s.v2 : (DEFAULTS[fluid][p1] ?? ''),
        v2: p2 === s.p2 ? s.v2 : (DEFAULTS[fluid][p2] ?? ''),
      }
    })

  const changeP2 = (p2: PropKey) => setSel((s) => ({ ...s, p2, v2: DEFAULTS[fluid][p2] ?? '' }))
  const swap = () => setSel((s) => ({ p1: s.p2, p2: s.p1, v1: s.v2, v2: s.v1 }))

  const toggleSign = (which: 1 | 2) =>
    setSel((s) => {
      const key = which === 1 ? 'v1' : 'v2'
      const cur = s[key].trim()
      return { ...s, [key]: cur.startsWith('-') ? cur.slice(1) : `-${cur}` }
    })

  const handleCopy = async (k: OutputKey, val: number) => {
    if (await copyToClipboard(formatValue(k, val))) {
      setCopiedKey(k)
      setTimeout(() => setCopiedKey((c) => (c === k ? null : c)), 1200)
    }
  }

  const addState = () => {
    if (!result.ok) return
    setCycle((prev) => [...prev, { ...result.state, id: nextId }])
    setNextId((n) => n + 1)
  }

  const moveState = (index: number, dir: -1 | 1) => {
    const target = index + dir
    if (target < 0 || target >= cycle.length) return
    setCycle((prev) => {
      const next = [...prev]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const removeState = (id: number) => setCycle((prev) => prev.filter((s) => s.id !== id))

  const renderInputRow = (
    index: 1 | 2,
    prop: PropKey,
    options: PropKey[],
    value: string,
    onPropChange: (p: PropKey) => void,
    onValueChange: (v: string) => void,
  ) => {
    const meta = PROPERTY_META[prop]
    return (
      <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 p-2">
        <select
          aria-label={`Propiedad ${index}`}
          value={prop}
          onChange={(e) => onPropChange(e.target.value as PropKey)}
          className="shrink-0 rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-2 text-xs font-medium text-zinc-200 outline-none focus:border-sky-500"
        >
          {options.map((k) => (
            <option key={k} value={k}>
              {PROPERTY_META[k].symbol} · {PROPERTY_META[k].label}
            </option>
          ))}
        </select>

        <div className="flex min-w-0 flex-1 items-center rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 focus-within:border-sky-500">
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            aria-label={`Valor de ${meta.label}`}
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder="0"
            className="min-w-0 flex-1 bg-transparent font-mono text-base font-medium tabular-nums text-zinc-100 outline-none placeholder:text-zinc-600"
          />
          <span className="ml-1.5 shrink-0 font-mono text-xs text-zinc-500">{meta.unit}</span>
        </div>

        {CAN_BE_NEGATIVE.includes(prop) && (
          <button
            type="button"
            onClick={() => toggleSign(index)}
            aria-label="Cambiar signo"
            className="h-9 w-9 shrink-0 rounded-lg border border-zinc-800 bg-zinc-950 font-mono text-sm font-semibold text-zinc-300 active:bg-zinc-800"
          >
            ±
          </button>
        )}
      </div>
    )
  }

  const secondDiagram: DiagramType = fluid === 'air' ? 'Pv' : 'Ph'

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col gap-2.5 bg-zinc-950 px-3 pb-6 pt-[max(0.75rem,env(safe-area-inset-top))]">
      {/* Encabezado mínimo */}
      <header className="flex items-center justify-between px-0.5">
        <h1 className="text-sm font-semibold tracking-tight text-zinc-100">Termonator</h1>
        <span className="font-mono text-[11px] text-zinc-500">SI · bar / °C / kJ</span>
      </header>

      {/* Selector de fluido */}
      <nav className="grid grid-cols-3 gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-1" aria-label="Fluido">
        {FLUIDS.map((f) => {
          const active = fluid === f.id
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => changeFluid(f.id)}
              aria-pressed={active}
              className={`rounded-md py-1.5 text-xs font-semibold transition-colors ${
                active ? 'bg-sky-500/15 text-sky-400 ring-1 ring-sky-500/40' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {f.name}
            </button>
          )
        })}
      </nav>

      {/* Entradas */}
      <section className="flex flex-col gap-1.5">
        {renderInputRow(1, sel.p1, options1, sel.v1, changeP1, (v1) => setSel((s) => ({ ...s, v1 })))}

        <div className="flex items-center justify-between px-1">
          <span className="text-[11px] text-zinc-500">Par independiente</span>
          <button
            type="button"
            onClick={swap}
            disabled={!getPairOptions(fluid, sel.p2).includes(sel.p1)}
            aria-label="Intercambiar propiedades"
            className="flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-400 active:bg-zinc-800 disabled:opacity-40"
          >
            <SwapIcon className="h-3 w-3" />
            Invertir
          </button>
        </div>

        {renderInputRow(2, sel.p2, options2, sel.v2, changeP2, (v2) => setSel((s) => ({ ...s, v2 })))}

        {fluid === 'air' && (
          <div className="grid grid-cols-[auto_1fr_1fr] items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-2">
            <span className="font-mono text-[11px] text-zinc-400">s₀=0</span>
            <label className="flex min-w-0 items-center rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 focus-within:border-sky-500">
              <span className="mr-1 font-mono text-[11px] text-zinc-500">T₀</span>
              <input
                type="text"
                inputMode="decimal"
                aria-label="Temperatura de referencia T0"
                value={airRef.T0}
                onChange={(e) => setAirRef((r) => ({ ...r, T0: e.target.value }))}
                className="min-w-0 flex-1 bg-transparent font-mono text-xs tabular-nums text-zinc-100 outline-none"
              />
              <span className="ml-1 font-mono text-[11px] text-zinc-500">°C</span>
            </label>
            <label className="flex min-w-0 items-center rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 focus-within:border-sky-500">
              <span className="mr-1 font-mono text-[11px] text-zinc-500">P₀</span>
              <input
                type="text"
                inputMode="decimal"
                aria-label="Presión de referencia P0"
                value={airRef.P0}
                onChange={(e) => setAirRef((r) => ({ ...r, P0: e.target.value }))}
                className="min-w-0 flex-1 bg-transparent font-mono text-xs tabular-nums text-zinc-100 outline-none"
              />
              <span className="ml-1 font-mono text-[11px] text-zinc-500">bar</span>
            </label>
          </div>
        )}
      </section>

      {/* Resultados o error */}
      <main aria-live="polite" className="flex flex-col gap-2">
        {result.ok ? (
          <>
            <section className="rounded-lg border border-zinc-800 bg-zinc-900">
              <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Estado</span>
                <span className="rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-xs font-medium text-sky-400">
                  {result.state.phase}
                </span>
              </div>

              <ul className="divide-y divide-zinc-800">
                {RESULT_KEYS.filter((k) => k !== 'x' || result.state.x !== null).map((k) => {
                  const meta = PROPERTY_META[k]
                  const raw = k === 'x' ? (result.state.x as number) : result.state[k]
                  const text = formatValue(k, raw)
                  const copied = copiedKey === k

                  return (
                    <li key={k} className="flex items-center justify-between gap-2 px-3 py-2">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className="w-4 font-mono text-sm font-semibold text-sky-400">{meta.symbol}</span>
                        <span className="truncate text-xs text-zinc-400">{meta.label}</span>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <span className="font-mono text-sm font-medium tabular-nums text-zinc-100">{text}</span>
                        <span className="w-12 text-right font-mono text-[11px] text-zinc-500">{meta.unit}</span>
                        <button
                          type="button"
                          onClick={() => handleCopy(k, raw)}
                          aria-label={`Copiar ${meta.label}`}
                          className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${
                            copied
                              ? 'border-sky-500/50 bg-sky-500/15 text-sky-400'
                              : 'border-zinc-800 bg-zinc-950 text-zinc-400 active:bg-zinc-800'
                          }`}
                        >
                          {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>

            <button
              type="button"
              onClick={addState}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900 py-2 text-xs font-semibold text-sky-400 transition-colors hover:border-sky-500/40 active:bg-zinc-800"
            >
              + Agregar como Estado {cycle.length + 1}
            </button>
          </>
        ) : (
          <div className="flex gap-2.5 rounded-lg border border-red-500/40 bg-zinc-900 p-3 text-xs text-red-300">
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <p>{result.error}</p>
          </div>
        )}
      </main>

      {/* Ciclo / Lista de Estados + Gráfico */}
      {cycle.length > 0 && (
        <section className="flex flex-col gap-2">
          {/* Lista de estados reordenable */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900">
            <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                Ciclo ({cycle.length})
              </span>
              <div className="flex items-center gap-3">
                <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-zinc-400">
                  <input
                    type="checkbox"
                    checked={closeCycle}
                    onChange={(e) => setCloseCycle(e.target.checked)}
                    className="h-3.5 w-3.5 accent-sky-500"
                  />
                  Cerrar ciclo
                </label>
                <button
                  type="button"
                  onClick={() => setCycle([])}
                  className="text-[11px] text-zinc-500 hover:text-red-400"
                >
                  Limpiar
                </button>
              </div>
            </div>

            <ul className="divide-y divide-zinc-800">
              {cycle.map((st, idx) => (
                <li key={st.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-xs font-semibold text-sky-400">Estado {idx + 1}</span>
                      <span className="truncate text-[11px] text-zinc-500">· {st.phase}</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-2.5 gap-y-0.5 font-mono text-[11px] tabular-nums text-zinc-300">
                      <span>P={formatValue('P', st.P)}</span>
                      <span>T={formatValue('T', st.T)}</span>
                      <span>h={formatValue('h', st.h)}</span>
                      <span>s={formatValue('s', st.s)}</span>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => moveState(idx, -1)}
                      disabled={idx === 0}
                      aria-label={`Subir Estado ${idx + 1}`}
                      className="flex h-7 w-7 items-center justify-center rounded border border-zinc-800 bg-zinc-950 font-mono text-xs text-zinc-300 active:bg-zinc-800 disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => moveState(idx, 1)}
                      disabled={idx === cycle.length - 1}
                      aria-label={`Bajar Estado ${idx + 1}`}
                      className="flex h-7 w-7 items-center justify-center rounded border border-zinc-800 bg-zinc-950 font-mono text-xs text-zinc-300 active:bg-zinc-800 disabled:opacity-30"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => removeState(st.id)}
                      aria-label={`Eliminar Estado ${idx + 1}`}
                      className="flex h-7 w-7 items-center justify-center rounded border border-zinc-800 bg-zinc-950 font-mono text-xs text-zinc-400 hover:text-red-400 active:bg-zinc-800"
                    >
                      ×
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* Gráfico SVG */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-2.5">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => adjustZoom(1 / 1.5)}
                  aria-label="Alejar gráfico"
                  className="flex h-6 w-6 items-center justify-center rounded border border-zinc-800 bg-zinc-950 font-mono text-xs text-zinc-300 active:bg-zinc-800"
                >
                  −
                </button>
                <button
                  type="button"
                  onClick={() => adjustZoom(1.5)}
                  aria-label="Acercar gráfico"
                  className="flex h-6 w-6 items-center justify-center rounded border border-zinc-800 bg-zinc-950 font-mono text-xs text-zinc-300 active:bg-zinc-800"
                >
                  +
                </button>
                {(zoom !== 1 || pan.x !== 0 || pan.y !== 0) && (
                  <button
                    type="button"
                    onClick={resetView}
                    className="rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 active:bg-zinc-800"
                  >
                    1:1
                  </button>
                )}
              </div>

              <div className="flex gap-1 rounded-md border border-zinc-800 bg-zinc-950 p-0.5">
                {(['Ts', secondDiagram] as DiagramType[]).map((d) => {
                  const active = activeDiagram === d
                  const label = d === 'Ts' ? 'T-s' : d === 'Ph' ? 'P-h' : 'P-v'
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => {
                        setDiagram(d)
                        resetView()
                      }}
                      className={`rounded px-2 py-0.5 font-mono text-[11px] font-medium ${
                        active ? 'bg-sky-500/15 text-sky-400' : 'text-zinc-500 hover:text-zinc-300'
                      }`}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>
            <CycleChart
              fluid={fluid}
              states={cycle}
              diagram={activeDiagram}
              closeCycle={closeCycle}
              zoom={zoom}
              pan={pan}
              onPan={(dx, dy) => setPan((p) => ({ x: p.x + dx, y: p.y + dy }))}
              onZoom={adjustZoom}
            />
          </div>
        </section>
      )}
    </div>
  )
}
