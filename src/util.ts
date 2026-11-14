// Porta de convert/flashforge/util.py do pacote de referência v0.2.3.
// Partes adaptadas de iChristGit/3MF-to-AD5X (MIT).

export type ListOrValue<T> = T | T[]

export function first<T>(v: ListOrValue<T> | undefined | null): T | undefined | null {
  if (Array.isArray(v)) return v.length ? v[0] : (v as unknown as T[])[0]
  return v
}

export function num(x: unknown): number | null {
  if (x === undefined || x === null) return null
  const s = String(x).trim().replace(/%$/, '')
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export function fmt(x: number, nd = 6): string {
  if (!Number.isFinite(x)) return '0'
  let s = x.toFixed(nd)
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  if (s === '' || s === '-0') return '0'
  return s
}

export function resize<T>(lst: T[], n: number): T[] {
  if (!lst || !lst.length) return lst
  if (lst.length >= n) return lst.slice(0, n)
  const last = lst[lst.length - 1]
  return [...lst, ...Array(n - lst.length).fill(last)]
}

export type Area = [number, number, number, number]
export function parseArea(area: ListOrValue<string> | string[]): Area {
  const arr = Array.isArray(area) ? area : [area]
  const pts = arr.map(p => {
    const [x, y] = String(p).split('x').map(Number)
    return [x, y] as [number, number]
  })
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

export function plateOrigin(idx: number, n: number, w: number, h: number, gap = 0.2): [number, number] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n) - 1e-9))
  return [(idx % cols) * w * (1 + gap), -Math.floor(idx / cols) * h * (1 + gap)]
}

export type Matrix12 = number[] // 12 floats; row-major 3x3 + translation last 3.
export function tfParse(s: string | null | undefined): Matrix12 {
  if (!s) return [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
  const parts = s.trim().split(/\s+/).map(Number)
  if (parts.length !== 12 || parts.some(v => !Number.isFinite(v))) return [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
  return parts
}

export function tfApply(t: Matrix12, x: number, y: number, z: number): [number, number, number] {
  return [
    x * t[0] + y * t[3] + z * t[6] + t[9],
    x * t[1] + y * t[4] + z * t[7] + t[10],
    x * t[2] + y * t[5] + z * t[8] + t[11],
  ]
}

export function tfMul(a: Matrix12, b: Matrix12): Matrix12 {
  const out: number[] = []
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out.push(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c])
    }
  }
  const [tx, ty, tz] = tfApply(b, a[9], a[10], a[11])
  return [...out, tx, ty, tz]
}
