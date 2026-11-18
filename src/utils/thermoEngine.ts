/**
 * thermoEngine.ts
 * ---------------------------------------------------------------------------
 * Motor termodinámico en TypeScript puro (sin dependencias externas).
 *
 * Unidades SI de entrada/salida:
 *   P [bar] · T [°C] · v [m³/kg] · u, h [kJ/kg] · s [kJ/kg·K] · x [-]
 * Internamente se trabaja con T en Kelvin y P en kPa (1 bar = 100 kPa).
 *
 * Modelos:
 *   - Agua  : IAPWS-IF97 (Región 1, Región 2 y Región 4).
 *   - R134a : Ecuación de estado de Tillner-Roth & Baehr (1994), explícita en
 *             energía de Helmholtz (líquido, vapor y supercrítico), con ecuación
 *             auxiliar tipo Wagner para Psat como valor inicial y saturación
 *             resuelta por igualdad de potencial químico (criterio de Maxwell).
 *   - Aire  : Gas ideal con calores específicos constantes.
 * ---------------------------------------------------------------------------
 */

// ============================================================================
// Tipos públicos
// ============================================================================

export type Fluid = 'water' | 'r134a' | 'air'
export type PropKey = 'P' | 'T' | 'v' | 'h' | 's' | 'x'
export type OutputKey = PropKey | 'u' | 'rho'

export type Phase =
  | 'Líquido subenfriado'
  | 'Líquido saturado'
  | 'Mezcla líquido-vapor'
  | 'Vapor saturado'
  | 'Vapor sobrecalentado'
  | 'Fluido supercrítico'
  | 'Gas ideal'

export interface ThermoState {
  fluid: Fluid
  phase: Phase
  /** bar */ P: number
  /** °C */ T: number
  /** m³/kg */ v: number
  /** kJ/kg */ u: number
  /** kJ/kg */ h: number
  /** kJ/kg·K */ s: number
  /** kg/m³ */ rho: number
  /** título (solo zona de saturación) */ x: number | null
}

export interface AirRef {
  /** °C */ T0: number
  /** bar */ P0: number
}

export type ThermoResult = { ok: true; state: ThermoState } | { ok: false; error: string }

export class ThermoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ThermoError'
  }
}

// ============================================================================
// Metadatos (para la interfaz)
// ============================================================================

export const PROPERTY_META: Record<OutputKey, { label: string; symbol: string; unit: string }> = {
  P: { label: 'Presión', symbol: 'P', unit: 'bar' },
  T: { label: 'Temperatura', symbol: 'T', unit: '°C' },
  v: { label: 'Volumen específico', symbol: 'v', unit: 'm³/kg' },
  u: { label: 'Energía interna', symbol: 'u', unit: 'kJ/kg' },
  h: { label: 'Entalpía', symbol: 'h', unit: 'kJ/kg' },
  s: { label: 'Entropía', symbol: 's', unit: 'kJ/kg·K' },
  x: { label: 'Título', symbol: 'x', unit: '–' },
  rho: { label: 'Densidad', symbol: 'ρ', unit: 'kg/m³' },
}

export const FLUIDS: { id: Fluid; name: string; model: string }[] = [
  { id: 'water', name: 'Agua', model: 'IAPWS-IF97 · 0–800 °C · hasta 100 MPa' },
  { id: 'r134a', name: 'R134a', model: 'Tillner-Roth & Baehr · −103–182 °C · hasta 70 MPa' },
  { id: 'air', name: 'Aire', model: 'Gas ideal · R = 0.287 · cp = 1.005 · cv = 0.718' },
]

const REAL_PAIRS: [PropKey, PropKey][] = [
  ['P', 'T'], ['P', 'x'], ['T', 'x'], ['P', 'h'], ['P', 's'],
  ['P', 'v'], ['T', 'h'], ['T', 's'], ['T', 'v'],
]

export const SUPPORTED_PAIRS: Record<Fluid, [PropKey, PropKey][]> = {
  water: REAL_PAIRS,
  r134a: REAL_PAIRS,
  air: [['P', 'T'], ['P', 'v'], ['T', 'v'], ['P', 'h'], ['P', 's'], ['T', 's']],
}

/** Propiedades disponibles para un fluido (orden de presentación). */
export function getFluidProps(fluid: Fluid): PropKey[] {
  const order: PropKey[] = ['P', 'T', 'v', 'h', 's', 'x']
  const set = new Set(SUPPORTED_PAIRS[fluid].flat())
  return order.filter((k) => set.has(k))
}

export function isPairSupported(fluid: Fluid, a: PropKey, b: PropKey): boolean {
  return SUPPORTED_PAIRS[fluid].some(([p, q]) => (p === a && q === b) || (p === b && q === a))
}

/** Propiedades que forman un par válido junto con `first`. */
export function getPairOptions(fluid: Fluid, first: PropKey): PropKey[] {
  return getFluidProps(fluid).filter((k) => k !== first && isPairSupported(fluid, first, k))
}

// ============================================================================
// Utilidades numéricas
// ============================================================================

const K0 = 273.15

/** Bisección robusta. Lanza ThermoError si no hay cambio de signo. */
function bisect(f: (x: number) => number, a: number, b: number, errMsg: string, tol = 1e-12): number {
  let fa = f(a)
  const fb = f(b)
  if (fa === 0) return a
  if (fb === 0) return b
  if (!Number.isFinite(fa) || !Number.isFinite(fb) || fa * fb > 0) throw new ThermoError(errMsg)
  for (let i = 0; i < 200; i++) {
    const m = 0.5 * (a + b)
    const fm = f(m)
    if (fm === 0 || Math.abs(b - a) < tol * Math.max(1, Math.abs(m))) return m
    if (fa * fm < 0) {
      b = m
    } else {
      a = m
      fa = fm
    }
  }
  return 0.5 * (a + b)
}

/** Bisección en escala logarítmica (útil para presiones). */
function bisectLog(f: (x: number) => number, a: number, b: number, errMsg: string): number {
  return Math.exp(bisect((lx) => f(Math.exp(lx)), Math.log(a), Math.log(b), errMsg))
}

interface Props {
  v: number
  u: number
  h: number
  s: number
}
type Hint = 'liq' | 'vap' | 'auto'

// ============================================================================
// AGUA — IAPWS-IF97
// ============================================================================

const R_W = 0.461526 // kJ/kg·K

// ---- Región 1 (líquido) ----
const R1_I = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 8, 8, 21, 23, 29, 30, 31, 32]
const R1_J = [-2, -1, 0, 1, 2, 3, 4, 5, -9, -7, -1, 0, 1, 3, -3, 0, 1, 3, 17, -4, 0, 6, -5, -2, 10, -8, -11, -6, -29, -31, -38, -39, -40, -41]
const R1_N = [
  0.14632971213167, -0.84548187169114, -0.3756360367204e1, 0.33855169168385e1, -0.95791963387872,
  0.15772038513228, -0.16616417199501e-1, 0.81214629983568e-3, 0.28319080123804e-3, -0.60706301565874e-3,
  -0.18990068218419e-1, -0.32529748770505e-1, -0.21841717175414e-1, -0.5283835796993e-4, -0.47184321073267e-3,
  -0.30001780793026e-3, 0.47661393906987e-4, -0.44141845330846e-5, -0.72694996297594e-15, -0.31679644845054e-4,
  -0.28270797985312e-5, -0.85205128120103e-9, -0.22425281908e-5, -0.65171222895601e-6, -0.14341729937924e-12,
  -0.40516996860117e-6, -0.12734301741641e-8, -0.17424871230634e-9, -0.68762131295531e-18, 0.14478307828521e-19,
  0.26335781662795e-22, -0.11947622640071e-22, 0.18228094581404e-23, -0.93537087292458e-25,
]

function waterRegion1(T: number, P: number): Props {
  const pi = P / 16530
  const tau = 1386 / T
  const a = 7.1 - pi
  const b = tau - 1.222
  let g = 0
  let gp = 0
  let gt = 0
  for (let k = 0; k < 34; k++) {
    const n = R1_N[k], I = R1_I[k], J = R1_J[k]
    g += n * a ** I * b ** J
    gp -= n * I * a ** (I - 1) * b ** J
    gt += n * a ** I * J * b ** (J - 1)
  }
  return {
    v: ((R_W * T) / P) * pi * gp,
    h: R_W * T * tau * gt,
    u: R_W * T * (tau * gt - pi * gp),
    s: R_W * (tau * gt - g),
  }
}

// ---- Región 2 (vapor) ----
const R2_J0 = [0, 1, -5, -4, -3, -2, -1, 2, 3]
const R2_N0 = [
  -0.96927686500217e1, 0.10086655968018e2, -0.5608791128302e-2, 0.71452738081455e-1, -0.40710498223928,
  0.14240819171444e1, -0.4383951131945e1, -0.28408632460772, 0.21268463753307e-1,
]
const R2_I = [1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 5, 6, 6, 6, 7, 7, 7, 8, 8, 9, 10, 10, 10, 16, 16, 18, 20, 20, 20, 21, 22, 23, 24, 24, 24]
const R2_J = [0, 1, 2, 3, 6, 1, 2, 4, 7, 36, 0, 1, 3, 6, 35, 1, 2, 3, 7, 3, 16, 35, 0, 11, 25, 8, 36, 13, 4, 10, 14, 29, 50, 57, 20, 35, 48, 21, 53, 39, 26, 40, 58]
const R2_N = [
  -0.17731742473213e-2, -0.17834862292358e-1, -0.45996013696365e-1, -0.57581259083432e-1, -0.5032527872793e-1,
  -0.33032641670203e-4, -0.18948987516315e-3, -0.39392777243355e-2, -0.43797295650573e-1, -0.26674547914087e-4,
  0.20481737692309e-7, 0.43870667284435e-6, -0.3227767723857e-4, -0.15033924542148e-2, -0.40668253562649e-1,
  -0.78847309559367e-9, 0.12790717852285e-7, 0.48225372718507e-6, 0.22922076337661e-5, -0.16714766451061e-10,
  -0.21171472321355e-2, -0.23895741934104e2, -0.5905956432427e-17, -0.12621808899101e-5, -0.38946842435739e-1,
  0.11256211360459e-10, -0.82311340897998e1, 0.19809712802088e-7, 0.10406965210174e-18, -0.10234747095929e-12,
  -0.10018179379511e-8, -0.80882908646985e-10, 0.10693031879409, -0.33662250574171, 0.89185845355421e-24,
  0.30629316876232e-12, -0.42002467698208e-5, -0.59056029685639e-25, 0.37826947613457e-5, -0.12768608934681e-14,
  0.73087610595061e-28, 0.55414715350778e-16, -0.9436970724121e-6,
]

function waterRegion2(T: number, P: number): Props {
  const pi = P / 1000
  const tau = 540 / T
  let g0 = Math.log(pi)
  let g0t = 0
  for (let k = 0; k < 9; k++) {
    g0 += R2_N0[k] * tau ** R2_J0[k]
    g0t += R2_N0[k] * R2_J0[k] * tau ** (R2_J0[k] - 1)
  }
  const g0p = 1 / pi
  const b = tau - 0.5
  let gr = 0
  let grp = 0
  let grt = 0
  for (let k = 0; k < 43; k++) {
    const n = R2_N[k], I = R2_I[k], J = R2_J[k]
    gr += n * pi ** I * b ** J
    grp += n * I * pi ** (I - 1) * b ** J
    grt += n * pi ** I * J * b ** (J - 1)
  }
  const gp = g0p + grp
  const gt = g0t + grt
  return {
    v: ((R_W * T) / P) * pi * gp,
    h: R_W * T * tau * gt,
    u: R_W * T * (tau * gt - pi * gp),
    s: R_W * (tau * gt - (g0 + gr)),
  }
}

// ---- Región 4 (saturación) ----
const R4 = [
  0, 0.11670521452767e4, -0.72421316703206e6, -0.17073846940092e2, 0.1202082470247e5, -0.32325550322333e7,
  0.1491510861353e2, -0.48232657361591e4, 0.40511340542057e6, -0.23855557567849, 0.65017534844798e3,
]

/** Presión de saturación del agua [kPa] para T [K]. */
function waterPsat(T: number): number {
  const th = T + R4[9] / (T - R4[10])
  const A = th * th + R4[1] * th + R4[2]
  const B = R4[3] * th * th + R4[4] * th + R4[5]
  const C = R4[6] * th * th + R4[7] * th + R4[8]
  return ((2 * C) / (-B + Math.sqrt(B * B - 4 * A * C))) ** 4 * 1000
}

/** Temperatura de saturación del agua [K] para P [kPa]. */
function waterTsat(P: number): number {
  const beta = (P / 1000) ** 0.25
  const E = beta * beta + R4[3] * beta + R4[6]
  const F = R4[1] * beta * beta + R4[4] * beta + R4[7]
  const G = R4[2] * beta * beta + R4[5] * beta + R4[8]
  const D = (2 * G) / (-F - Math.sqrt(F * F - 4 * E * G))
  return (R4[10] + D - Math.sqrt((R4[10] + D) ** 2 - 4 * (R4[9] + R4[10] * D))) / 2
}

/** Frontera Región 2 – Región 3 [kPa]. */
function waterPB23(T: number): number {
  return (0.34805185628969e3 - 0.11671859879975e1 * T + 0.10192970039326e-2 * T * T) * 1000
}

/** Inversa de la frontera B23: T [K] para P [kPa]. */
function waterTB23(P: number): number {
  return 0.57254459862746e3 + Math.sqrt((P / 1000 - 0.1391883977887e2) / 0.10192970039326e-2)
}

const REGION3_MSG =
  'El estado cae en la Región 3 de IF97 (cercana al punto crítico: T > 350 °C y P elevada), que no está implementada.'

function waterSingle(T: number, P: number, hint: Hint): Props {
  if (T <= 623.15) {
    const region = hint === 'liq' ? 1 : hint === 'vap' ? 2 : P >= waterPsat(T) ? 1 : 2
    return region === 1 ? waterRegion1(T, P) : waterRegion2(T, P)
  }
  if (T <= 863.15 && P > waterPB23(T)) throw new ThermoError(REGION3_MSG)
  return waterRegion2(T, P)
}

// ============================================================================
// R134a — Tillner-Roth & Baehr (1994), Helmholtz explícita
// ============================================================================

const R_R = 8.314471 / 102.032 // kJ/kg·K
const TC_R = 374.18 // K
const RHOC_R = 508 // kg/m³
const PC_R = 4056.29 // kPa

// Parte de gas ideal: φ° = a1 + a2·τ + a3·ln τ + ln δ + a4·τ^-0.5 + a5·τ^-0.75
const A0 = [-1.019535, 9.047135, -1.629789, -9.723916, -3.92717]

// Parte residual: a_i · δ^d · τ^t · exp(−δ^l)   (l = 0 → sin exponencial)
const RA = [
  0.5586817e-1, 0.498223, 0.2458698e-1, 0.8570145e-3, 0.4788584e-3, -0.1800808e1, 0.2671641, -0.4781652e-1,
  0.1423987e-1, 0.3324062, -0.7485907e-2, 0.1017263e-3, -0.5184567, -0.8692288e-1, 0.2057144, -0.5000457e-2,
  0.4603262e-3, -0.3497836e-2, 0.6995038e-2, -0.1452184e-1, -0.1285458e-3,
]
const RT = [-0.5, 0, 0, 0, 1.5, 1.5, 2, 2, 1, 3, 5, 1, 5, 5, 6, 10, 10, 10, 18, 22, 50]
const RD = [2, 1, 3, 6, 6, 1, 1, 2, 5, 2, 2, 4, 1, 4, 1, 2, 4, 1, 5, 3, 10]
const RL = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3, 4]

/** Parte residual y sus derivadas: φr, φr_δ, φr_δδ, φr_τ. */
function phiR(d: number, t: number) {
  let f = 0, fd = 0, fdd = 0, ft = 0
  for (let k = 0; k < 21; k++) {
    const a = RA[k], ti = RT[k], di = RD[k], li = RL[k]
    const tt = t ** ti
    if (li === 0) {
      const dd = d ** di
      f += a * dd * tt
      fd += a * di * d ** (di - 1) * tt
      fdd += a * di * (di - 1) * d ** (di - 2) * tt
      ft += a * ti * dd * t ** (ti - 1)
    } else {
      const dl = d ** li
      const e = Math.exp(-dl)
      const dd = d ** di
      f += a * dd * tt * e
      fd += a * tt * e * d ** (di - 1) * (di - li * dl)
      fdd += a * tt * e * d ** (di - 2) * ((di - li * dl) * (di - 1 - li * dl) - li * li * dl)
      ft += a * ti * dd * t ** (ti - 1) * e
    }
  }
  return { f, fd, fdd, ft }
}

/** Presión [kPa] y dP/dρ para R134a a (T [K], ρ [kg/m³]). */
function r134aPressure(T: number, rho: number) {
  const d = rho / RHOC_R
  const r = phiR(d, TC_R / T)
  return {
    p: rho * R_R * T * (1 + d * r.fd),
    dpdrho: R_R * T * (1 + 2 * d * r.fd + d * d * r.fdd),
  }
}

/** Propiedades "crudas" (sin corrimiento de referencia) + energía de Gibbs. */
function r134aRaw(T: number, rho: number): Props & { g: number; p: number } {
  const d = rho / RHOC_R
  const t = TC_R / T
  const r = phiR(d, t)
  const f0 = A0[0] + A0[1] * t + A0[2] * Math.log(t) + Math.log(d) + A0[3] * t ** -0.5 + A0[4] * t ** -0.75
  const f0t = A0[1] + A0[2] / t - 0.5 * A0[3] * t ** -1.5 - 0.75 * A0[4] * t ** -1.75
  const RTm = R_R * T
  const tauPhiT = t * (f0t + r.ft)
  return {
    p: rho * RTm * (1 + d * r.fd),
    v: 1 / rho,
    u: RTm * tauPhiT,
    h: RTm * (1 + tauPhiT + d * r.fd),
    s: R_R * (tauPhiT - f0 - r.f),
    g: RTm * (1 + f0 + r.f + d * r.fd),
  }
}

/** Ecuación auxiliar tipo Wagner para Psat del R134a [kPa] (valor inicial). */
function r134aPsatAnc(T: number): number {
  const th = 1 - T / TC_R
  return PC_R * Math.exp((TC_R / T) * (-7.686556 * th + 2.311791 * th ** 1.5 - 2.039554 * th ** 2 - 3.583758 * th ** 4))
}

/** Newton para ρ(T, P) partiendo de rho0. Devuelve null si no converge. */
function newtonRho(T: number, P: number, rho0: number): number | null {
  let rho = rho0
  for (let i = 0; i < 100; i++) {
    const { p, dpdrho } = r134aPressure(T, rho)
    if (!(dpdrho > 0)) return null
    let next = rho - (p - P) / dpdrho
    if (next <= 0) next = rho / 2
    if (Math.abs(next - rho) < 1e-11 * rho) return next
    rho = next
  }
  return null
}

const RHO_LIQ_START = 1750 // kg/m³ (por encima del líquido en el punto triple)

function r134aRho(T: number, P: number, hint: Hint): number {
  if (T < TC_R) {
    const h = hint === 'auto' ? (P >= r134aPsatAnc(T) ? 'liq' : 'vap') : hint
    const rho = newtonRho(T, P, h === 'liq' ? RHO_LIQ_START : P / (R_R * T))
    if (rho !== null && (h === 'liq' ? rho > RHOC_R : rho < RHOC_R)) return rho
    throw new ThermoError('No se pudo resolver la densidad del R134a para este estado.')
  }
  const rho = newtonRho(T, P, P < PC_R ? P / (R_R * T) : RHO_LIQ_START)
  if (rho !== null) return rho
  return bisect((r) => r134aPressure(T, r).p - P, 1e-8, 1800, 'No se pudo resolver la densidad del R134a.')
}

interface SatRaw {
  P: number
  rhoL: number
  rhoV: number
}
const satCache = new Map<number, SatRaw>()

/** Saturación R134a por igualdad de Gibbs (Maxwell) a temperatura T [K]. */
function r134aSatRaw(T: number): SatRaw {
  const cached = satCache.get(T)
  if (cached) return cached
  let P = r134aPsatAnc(T)
  let rhoL = 0, rhoV = 0
  for (let i = 0; i < 100; i++) {
    const l = newtonRho(T, P, RHO_LIQ_START)
    const v = newtonRho(T, P, P / (R_R * T))
    if (l === null || v === null) throw new ThermoError('No convergió el cálculo de saturación del R134a.')
    rhoL = l
    rhoV = v
    const gl = r134aRaw(T, l).g
    const gv = r134aRaw(T, v).g
    const dP = (gv - gl) / (1 / v - 1 / l) // dg/dP = v a T constante
    P -= dP
    if (Math.abs(dP) < 1e-10 * P) break
  }
  const res = { P, rhoL, rhoV }
  if (satCache.size > 2000) satCache.clear()
  satCache.set(T, res)
  return res
}

// Corrimiento del estado de referencia.
// 'ASHRAE': h = 0, s = 0 para líquido saturado a −40 °C (tablas de Çengel).
// 'IIR'   : h = 200 kJ/kg, s = 1 kJ/kg·K para líquido saturado a 0 °C.
const R134A_REFERENCE: 'ASHRAE' | 'IIR' = 'IIR'
let refOffset: { h: number; s: number } | null = null

function r134aOffset() {
  if (!refOffset) {
    const [Tref, href, sref] = R134A_REFERENCE === 'ASHRAE' ? [233.15, 0, 0] : [273.15, 200, 1]
    const raw = r134aRaw(Tref, r134aSatRaw(Tref).rhoL)
    refOffset = { h: href - raw.h, s: sref - raw.s }
  }
  return refOffset
}

function r134aProps(T: number, rho: number): Props {
  const raw = r134aRaw(T, rho)
  const off = r134aOffset()
  return { v: 1 / rho, u: raw.u + off.h, h: raw.h + off.h, s: raw.s + off.s }
}

// ============================================================================
// Modelo genérico de fluido real (Agua / R134a)
// ============================================================================

interface RealFluidModel {
  name: string
  Tmin: number // K
  Tmax: number // K
  Pmin: number // kPa
  Pmax: number // kPa
  Tc: number
  Pc: number
  /** T máxima a la que se calcula la zona bifásica. */
  TsatMax: number
  psat(T: number): number
  tsat(P: number): number
  /** Psat aproximada (rápida) para clasificar fases cerca del punto crítico. */
  psatApprox(T: number): number
  sat(T: number): { P: number; liq: Props; vap: Props }
  single(T: number, P: number, hint: Hint): Props
  /** Intervalos de T [K] donde el modelo es válido a la presión P (fuera de la zona bifásica). */
  tSegmentsAtP(P: number): [number, number][]
  /** Presión máxima [kPa] válida a la temperatura T. */
  pmaxAtT(T: number): number
}

const WATER: RealFluidModel = {
  name: 'Agua',
  Tmin: 273.15,
  Tmax: 1073.15,
  Pmin: 1e-3,
  Pmax: 100000,
  Tc: 647.096,
  Pc: 22064,
  TsatMax: 623.15,
  psat: waterPsat,
  tsat: waterTsat,
  psatApprox: waterPsat,
  sat(T) {
    const P = waterPsat(T)
    return { P, liq: waterRegion1(T, P), vap: waterRegion2(T, P) }
  },
  single(T, P, hint) {
    checkRange(this, T, P)
    return waterSingle(T, P, hint)
  },
  tSegmentsAtP(P) {
    if (P <= waterPsat(623.15)) return [[this.Tmin, this.Tmax]]
    return [
      [this.Tmin, 623.15],
      [Math.min(waterTB23(P) + 1e-7, this.Tmax), this.Tmax],
    ]
  },
  pmaxAtT(T) {
    return T > 623.15 && T <= 863.15 ? Math.min(waterPB23(T) * (1 - 1e-9), this.Pmax) : this.Pmax
  },
}

const R134A_TSAT_MAX = 374.0 // K (≈ Tc − 0.18 K)

const R134A: RealFluidModel = {
  name: 'R134a',
  Tmin: 169.85,
  Tmax: 455,
  Pmin: 1e-3,
  Pmax: 70000,
  Tc: TC_R,
  Pc: PC_R,
  TsatMax: R134A_TSAT_MAX,
  psat: (T) => r134aSatRaw(T).P,
  tsat(P) {
    // 1) inversión de la ecuación auxiliar; 2) refinamiento por secante con la EOS
    let T0 = bisect((T) => r134aPsatAnc(T) - P, this.Tmin, R134A_TSAT_MAX + 0.18, 'Presión fuera del rango de saturación.')
    T0 = Math.min(Math.max(T0, this.Tmin), R134A_TSAT_MAX)
    let T1 = T0 - 0.01
    let f0 = this.psat(T0) - P
    let f1 = this.psat(T1) - P
    for (let i = 0; i < 30 && Math.abs(f1) > 1e-10 * P && f1 !== f0; i++) {
      const T2 = Math.min(Math.max(T1 - (f1 * (T1 - T0)) / (f1 - f0), this.Tmin), R134A_TSAT_MAX)
      T0 = T1
      f0 = f1
      T1 = T2
      f1 = this.psat(T1) - P
    }
    return T1
  },
  psatApprox: r134aPsatAnc,
  sat(T) {
    const s = r134aSatRaw(T)
    return { P: s.P, liq: r134aProps(T, s.rhoL), vap: r134aProps(T, s.rhoV) }
  },
  single(T, P, hint) {
    checkRange(this, T, P)
    return r134aProps(T, r134aRho(T, P, hint))
  },
  tSegmentsAtP() {
    return [[this.Tmin, this.Tmax]]
  },
  pmaxAtT() {
    return this.Pmax
  },
}

const fmtC = (K: number) => `${(K - K0).toFixed(2)} °C`

function checkRange(m: RealFluidModel, T: number, P: number) {
  if (T < m.Tmin - 1e-9 || T > m.Tmax + 1e-9)
    throw new ThermoError(`${m.name}: la temperatura debe estar entre ${fmtC(m.Tmin)} y ${fmtC(m.Tmax)}.`)
  if (!(P > 0) || P > m.Pmax + 1e-9)
    throw new ThermoError(`${m.name}: la presión debe ser mayor que 0 y menor que ${(m.Pmax / 100).toLocaleString('es-AR')} bar.`)
}

const SAT_RANGE_MSG = (m: RealFluidModel) =>
  `${m.name}: la zona de saturación está disponible entre ${fmtC(m.Tmin)} y ${fmtC(m.TsatMax)} ` +
  `(${(m.psat(m.Tmin) / 100).toFixed(5)} – ${(m.psat(m.TsatMax) / 100).toFixed(2)} bar).`

function classify(m: RealFluidModel, T: number, P: number, hint: Hint): Phase {
  if (T >= m.Tc && P >= m.Pc) return 'Fluido supercrítico'
  if (hint === 'liq') return 'Líquido subenfriado'
  if (hint === 'vap') return 'Vapor sobrecalentado'
  if (T >= m.Tc) return 'Vapor sobrecalentado'
  if (P >= m.Pc) return 'Líquido subenfriado'
  return P >= m.psatApprox(T) ? 'Líquido subenfriado' : 'Vapor sobrecalentado'
}

interface RawState {
  T: number // K
  P: number
  props: Props
  x: number | null
  phase: Phase
}

function mixState(m: RealFluidModel, T: number, x: number): RawState {
  const s = m.sat(T)
  const mix = (k: keyof Props) => s.liq[k] + x * (s.vap[k] - s.liq[k])
  const phase: Phase = x === 0 ? 'Líquido saturado' : x === 1 ? 'Vapor saturado' : 'Mezcla líquido-vapor'
  return { T, P: s.P, props: { v: mix('v'), u: mix('u'), h: mix('h'), s: mix('s') }, x, phase }
}

function singleState(m: RealFluidModel, T: number, P: number, hint: Hint): RawState {
  return { T, P, props: m.single(T, P, hint), x: null, phase: classify(m, T, P, hint) }
}

function checkX(x: number) {
  if (x < 0 || x > 1)
    throw new ThermoError('El título x debe estar entre 0 y 1 (solo existe en la zona de mezcla líquido-vapor).')
}

// ---- (P, T) ----
function solveTP(m: RealFluidModel, T: number, P: number): RawState {
  checkRange(m, T, P)
  if (T <= m.TsatMax) {
    const Psat = m.psat(T)
    if (P <= m.psat(m.TsatMax) && P >= m.psat(m.Tmin) && Math.abs(m.tsat(P) - T) < 0.01) {
      throw new ThermoError(
        `P y T corresponden a la zona de saturación (Tsat = ${fmtC(m.tsat(P))} a ${(P / 100).toFixed(4)} bar). ` +
          'En la zona bifásica P y T no son independientes: ingresá x, v, h o s como segunda propiedad.',
      )
    }
    return singleState(m, T, P, P > Psat ? 'liq' : 'vap')
  }
  return singleState(m, T, P, 'auto')
}

// ---- (T, x) y (P, x) ----
function solveTx(m: RealFluidModel, T: number, x: number): RawState {
  checkX(x)
  if (T < m.Tmin - 1e-9 || T > m.TsatMax + 1e-9) throw new ThermoError(SAT_RANGE_MSG(m))
  return mixState(m, T, x)
}

function solvePx(m: RealFluidModel, P: number, x: number): RawState {
  checkX(x)
  if (P < m.psat(m.Tmin) * (1 - 1e-9) || P > m.psat(m.TsatMax) * (1 + 1e-9)) throw new ThermoError(SAT_RANGE_MSG(m))
  return mixState(m, m.tsat(P), x)
}

const outOfRange = (m: RealFluidModel, key: PropKey, given: 'P' | 'T') =>
  `${m.name}: no existe un estado con ese valor de ${key} a la ${given === 'P' ? 'presión' : 'temperatura'} indicada dentro del rango del modelo.`

/** Determina x a partir de y = yl + x(yv − yl), con tolerancia en los extremos. */
function qualityFrom(yl: number, yv: number, y: number): number {
  const x = (y - yl) / (yv - yl)
  if (Math.abs(x) < 1e-9) return 0
  if (Math.abs(x - 1) < 1e-9) return 1
  return x
}

// ---- (P, h|s|v) ----
function solvePy(m: RealFluidModel, P: number, key: 'h' | 's' | 'v', val: number): RawState {
  if (!(P > 0) || P > m.Pmax) checkRange(m, m.Tmin, P)
  const f = (hint: Hint) => (T: number) => m.single(T, P, hint)[key] - val
  const PsatMin = m.psat(m.Tmin)
  const PsatMax = m.psat(m.TsatMax)

  if (P >= PsatMin && P <= PsatMax) {
    const Ts = m.tsat(P)
    const sat = m.sat(Ts)
    const x = qualityFrom(sat.liq[key], sat.vap[key], val)
    if (x >= 0 && x <= 1) return mixState(m, Ts, x)
    if (x < 0) return singleState(m, bisect(f('liq'), m.Tmin, Ts, outOfRange(m, key, 'P')), P, 'liq')
    return singleState(m, bisect(f('vap'), Ts, m.Tmax, outOfRange(m, key, 'P')), P, 'vap')
  }
  const hint: Hint = P < PsatMin ? 'vap' : 'auto'
  // Buscar en los intervalos de T válidos del modelo (el agua excluye la Región 3).
  for (const [lo, hi] of m.tSegmentsAtP(P)) {
    const g = f(hint)
    if (g(lo) * g(hi) <= 0) return singleState(m, bisect(g, lo, hi, outOfRange(m, key, 'P')), P, hint)
  }
  throw new ThermoError(outOfRange(m, key, 'P') + (m === WATER && P > PsatMax ? ' ' + REGION3_MSG : ''))
}

// ---- (T, h|s|v) ----
function solveTy(m: RealFluidModel, T: number, key: 'h' | 's' | 'v', val: number): RawState {
  checkRange(m, T, 1)
  const f = (hint: Hint) => (P: number) => m.single(T, P, hint)[key] - val

  if (T <= m.TsatMax) {
    const sat = m.sat(T)
    const x = qualityFrom(sat.liq[key], sat.vap[key], val)
    if (x >= 0 && x <= 1) return mixState(m, T, x)
    if (x < 0) return singleState(m, T, bisectLog(f('liq'), sat.P, m.Pmax, outOfRange(m, key, 'T')), 'liq')
    return singleState(m, T, bisectLog(f('vap'), m.Pmin, sat.P, outOfRange(m, key, 'T')), 'vap')
  }
  const Pmax = m.pmaxAtT(T)
  try {
    const P = bisectLog(f('auto'), m.Pmin, Pmax, outOfRange(m, key, 'T'))
    return singleState(m, T, P, 'auto')
  } catch (e) {
    if (e instanceof ThermoError && Pmax < m.Pmax && !e.message.includes('Región 3'))
      throw new ThermoError(e.message + ' ' + REGION3_MSG)
    throw e
  }
}

// ============================================================================
// AIRE — gas ideal, calores específicos constantes
// ============================================================================

const AIR = { R: 0.287, cp: 1.005, cv: 0.718 }
// Referencia por defecto: medio a T0 = 0 °C (273.15 K) y P0 = 1 bar (100 kPa) con s0 = 0.
const DEFAULT_AIR_REF: AirRef = { T0: 0, P0: 1 }

function airEntropy(T: number, P: number, T0: number, P0: number) {
  return AIR.cp * Math.log(T / T0) - AIR.R * Math.log(P / P0)
}

function solveAir(a: PropKey, va: number, b: PropKey, vb: number, airRef: AirRef): RawState {
  if (!Number.isFinite(airRef.T0) || !Number.isFinite(airRef.P0))
    throw new ThermoError('Aire: ingresá valores válidos para el medio de referencia (T0 y P0).')
  const T0 = airRef.T0 + K0
  const P0 = airRef.P0
  if (!(T0 > 0)) throw new ThermoError('Aire: T0 de referencia debe ser mayor que −273.15 °C.')
  if (!(P0 > 0)) throw new ThermoError('Aire: P0 de referencia debe ser mayor que 0.')

  const get = (k: PropKey) => (a === k ? va : b === k ? vb : NaN)
  const has = (k: PropKey) => a === k || b === k
  let T = NaN
  let P = NaN

  const positive = (k: PropKey, label: string) => {
    if (has(k) && !(get(k) > 0)) throw new ThermoError(`Aire: ${label} debe ser mayor que 0.`)
  }
  positive('P', 'la presión')
  positive('v', 'el volumen específico')
  positive('h', 'la entalpía (referencia h = cp·T absoluta)')
  if (has('T') && !(get('T') + K0 > 0)) throw new ThermoError('Aire: la temperatura debe ser mayor que −273.15 °C.')

  if (has('P') && has('T')) { P = get('P'); T = get('T') + K0 }
  else if (has('P') && has('v')) { P = get('P'); T = (P * get('v')) / AIR.R }
  else if (has('T') && has('v')) { T = get('T') + K0; P = (AIR.R * T) / get('v') }
  else if (has('P') && has('h')) { P = get('P'); T = get('h') / AIR.cp }
  else if (has('P') && has('s')) {
    P = get('P')
    T = T0 * Math.exp((get('s') + AIR.R * Math.log(P / P0)) / AIR.cp)
  } else if (has('T') && has('s')) {
    T = get('T') + K0
    P = P0 * Math.exp((AIR.cp * Math.log(T / T0) - get('s')) / AIR.R)
  } else throw new ThermoError('Par de propiedades no soportado para el aire.')

  return {
    T,
    P,
    props: { v: (AIR.R * T) / P, u: AIR.cv * T, h: AIR.cp * T, s: airEntropy(T, P, T0, P0) },
    x: null,
    phase: 'Gas ideal',
  }
}

// ============================================================================
// API principal
// ============================================================================

/**
 * Calcula el estado termodinámico a partir de dos propiedades independientes.
 * Las entradas usan: P [bar], T [°C], v [m³/kg], h [kJ/kg], s [kJ/kg·K], x [-].
 */
export function computeState(
  fluid: Fluid,
  a: PropKey,
  va: number,
  b: PropKey,
  vb: number,
  airRef: AirRef = DEFAULT_AIR_REF,
): ThermoResult {
  try {
    if (!Number.isFinite(va) || !Number.isFinite(vb)) throw new ThermoError('Ingresá valores numéricos válidos.')
    if (a === b) throw new ThermoError('Elegí dos propiedades distintas.')
    if (!isPairSupported(fluid, a, b))
      throw new ThermoError(`El par (${a}, ${b}) no está soportado para este fluido.`)

    // Conversión de P de bar a kPa para el cálculo interno (1 bar = 100 kPa)
    const vaKpa = a === 'P' ? va * 100 : va
    const vbKpa = b === 'P' ? vb * 100 : vb
    const airRefKpa: AirRef = { T0: airRef.T0, P0: airRef.P0 * 100 }

    let raw: RawState
    if (fluid === 'air') {
      raw = solveAir(a, vaKpa, b, vbKpa, airRefKpa)
    } else {
      const m = fluid === 'water' ? WATER : R134A
      const get = (k: PropKey) => (a === k ? vaKpa : vbKpa)
      const has = (k: PropKey) => a === k || b === k
      const other = (a === 'P' || a === 'T' ? b : a) as PropKey

      if (has('P') && has('T')) raw = solveTP(m, get('T') + K0, get('P'))
      else if (has('T') && has('x')) raw = solveTx(m, get('T') + K0, get('x'))
      else if (has('P') && has('x')) raw = solvePx(m, get('P'), get('x'))
      else if (has('P')) raw = solvePy(m, get('P'), other as 'h' | 's' | 'v', get(other))
      else raw = solveTy(m, get('T') + K0, other as 'h' | 's' | 'v', get(other))
    }

    const { T, P, props, x, phase } = raw
    if (![T, P, props.v, props.u, props.h, props.s].every(Number.isFinite))
      throw new ThermoError('El cálculo no convergió para este estado.')

    return {
      ok: true,
      state: { fluid, phase, P: P / 100, T: T - K0, v: props.v, u: props.u, h: props.h, s: props.s, rho: 1 / props.v, x },
    }
  } catch (e) {
    if (e instanceof ThermoError) return { ok: false, error: e.message }
    return { ok: false, error: 'Error inesperado en el cálculo.' }
  }
}
