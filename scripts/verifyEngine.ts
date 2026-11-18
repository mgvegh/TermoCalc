// Verificación del motor contra valores de referencia (IF97 oficiales y tablas). Presión en bar.
// Ejecutar: npm run test:engine
import { computeState, type Fluid, type PropKey } from '../src/utils/thermoEngine.ts'

type Case = [string, Fluid, PropKey, number, PropKey, number, Partial<Record<'P' | 'T' | 'v' | 'h' | 's' | 'u' | 'x', number>>]

const cases: Case[] = [
  // IF97 verificación oficial (Región 1)
  ['IF97 R1 300K 30bar', 'water', 'P', 30, 'T', 26.85, { v: 0.100215168e-2, h: 115.331273, u: 112.324818, s: 0.392294792 }],
  ['IF97 R1 300K 800bar', 'water', 'P', 800, 'T', 26.85, { v: 0.971180894e-3, h: 184.142828 }],
  ['IF97 R1 500K 30bar', 'water', 'P', 30, 'T', 226.85, { v: 0.1202418e-2, h: 975.542239 }],
  // IF97 Región 2
  ['IF97 R2 300K 0.035bar', 'water', 'P', 0.035, 'T', 26.85, { v: 39.4913866, h: 2549.1145, s: 8.52238967 }],
  ['IF97 R2 700K 0.035bar', 'water', 'P', 0.035, 'T', 426.85, { v: 92.3015898, h: 3335.68375 }],
  ['IF97 R2 700K 300bar', 'water', 'P', 300, 'T', 426.85, { v: 0.542946619e-2, h: 2631.49474 }],
  // Saturación
  ['Agua Tsat 1bar', 'water', 'P', 1, 'x', 0, { T: 372.755919 - 273.15 }],
  ['Agua Psat 500K', 'water', 'T', 226.85, 'x', 1, { P: 26.3889776 }],
  ['Agua mezcla 2bar x=0.5', 'water', 'P', 2, 'x', 0.5, { T: 120.21 }],
  // Inversas agua
  ['Agua (P,h) recupera T', 'water', 'P', 30, 'h', 975.542239, { T: 226.85 }],
  ['Agua (P,s) vapor', 'water', 'P', 0.035, 's', 8.52238967, { T: 26.85 }],
  ['Agua (T,v) vapor', 'water', 'T', 426.85, 'v', 0.542946619e-2, { P: 300 }],
  ['Agua (T,s) líquido', 'water', 'T', 26.85, 's', 0.392294792, { P: 30 }],
  ['Agua (P,h) mezcla', 'water', 'P', 1, 'h', 1500, {}],
  ['Agua (P,h) 200bar vapor (seg. R2)', 'water', 'P', 200, 'h', 3500, {}],
  ['Agua (P,h) 200bar líquido', 'water', 'P', 200, 'h', 1000, {}],
  ['Agua (T,h) 600°C', 'water', 'T', 600, 'h', 3600, {}],
  ['Agua (P,v) 10bar', 'water', 'P', 10, 'v', 0.25799, { T: 300 }],
  ['R134a (T,v) líquido comprimido', 'r134a', 'T', 20, 'v', 0.000814544, { P: 10 }],
  ['R134a sat 100°C', 'r134a', 'T', 100, 'x', 0.5, { P: 39.724 }],
  ['R134a sat −100°C', 'r134a', 'T', -100, 'x', 0.5, {}],
  ['R134a (P,s) líquido', 'r134a', 'P', 20, 's', 1.08, {}],
  // R134a (referencia IIR: h=200 kJ/kg, s=1 kJ/kg·K para líquido sat. a 0 °C)
  ['R134a sat 0°C (ref IIR)', 'r134a', 'T', 0, 'x', 0, { P: 2.92803, h: 200, s: 1 }],
  ['R134a sat 40°C', 'r134a', 'T', 40, 'x', 1, { P: 10.16593 }],
  ['R134a Tsat 1.01325bar', 'r134a', 'P', 1.01325, 'x', 0.3, { T: -26.074 }],
  ['R134a sobrecal. 1bar 20°C', 'r134a', 'P', 1, 'T', 20, {}],
  ['R134a sobrecal. 8bar 50°C', 'r134a', 'P', 8, 'T', 50, {}],
  ['R134a líquido 10bar 20°C', 'r134a', 'P', 10, 'T', 20, {}],
  ['R134a (P,h) inversa', 'r134a', 'P', 8, 'h', 430, {}],
  ['R134a (T,s) vapor', 'r134a', 'T', 60, 's', 1.8, {}],
  ['R134a supercrítico', 'r134a', 'P', 50, 'T', 120, {}],
  // Aire (ref por defecto: T0 = 0 °C = 273.15 K, P0 = 1 bar = 100 kPa, s0 = 0)
  ['Aire (P,T) 1bar 305K', 'air', 'P', 1, 'T', 305 - 273.15, { v: 0.87535, s: 0.11084 }],
  ['Aire (P,s) ida y vuelta', 'air', 'P', 5, 's', 0.11084, {}],
  // Errores esperados
  ['ERR (P,T) en saturación', 'water', 'P', 1.01418, 'T', 100, {}],
  ['ERR x > 1', 'water', 'P', 1, 'x', 1.3, {}],
  ['ERR región 3', 'water', 'P', 250, 'T', 380, {}],
]

let fails = 0
for (const [name, fluid, a, va, b, vb, expect] of cases) {
  const t0 = performance.now()
  const r = computeState(fluid, a, va, b, vb)
  const ms = (performance.now() - t0).toFixed(1)
  if (!r.ok) {
    const expectedErr = name.startsWith('ERR')
    if (!expectedErr) fails++
    console.log(`${expectedErr ? 'OK ' : 'FAIL'} ${name} -> ERROR: ${r.error}`)
    continue
  }
  const s = r.state
  const bad = Object.entries(expect).filter(([k, ref]) => {
    const val = s[k as keyof typeof s] as number
    return Math.abs(val - ref!) > Math.max(2e-3 * Math.abs(ref!), 0.02)
  })
  if (bad.length || name.startsWith('ERR')) fails++
  console.log(
    `${bad.length || name.startsWith('ERR') ? 'FAIL' : 'OK  '} ${name} [${ms} ms] ${s.phase} | ` +
      `P=${s.P.toFixed(4)} T=${s.T.toFixed(3)} v=${s.v.toPrecision(6)} u=${s.u.toFixed(3)} h=${s.h.toFixed(3)} s=${s.s.toFixed(5)} x=${s.x}` +
      (bad.length ? `  <-- esperado ${JSON.stringify(expect)}` : ''),
  )
}
console.log(fails ? `\n${fails} fallas` : '\nTodo OK')
process.exit(fails ? 1 : 0)
