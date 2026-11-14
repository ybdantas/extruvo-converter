// Porta de convert/flashforge/model3mf.py (v0.2.3).
// Partes adaptadas de iChristGit/3MF-to-AD5X (MIT).
import type JSZip from 'jszip'
import { tfApply, tfMul, tfParse, type Matrix12 } from './util'

export const ROOT_MODEL = '3D/3dmodel.model'
export const MODEL_SETTINGS = 'Metadata/model_settings.config'
export const CUSTOM_GCODE = 'Metadata/custom_gcode_per_layer.xml'

export const CACHE_RE = /^Metadata\/(plate_\d+\.(gcode|json)(\.md5)?|plate_\d+\.gcode\.md5|filament_sequence\.json|cut_information\.xml)$/

const BUILD_RE = /(<build\b[^>]*>)([\s\S]*?)(<\/build>)/
const BUILD_ITEM_RE = /<item\b[^>]*>/g

const dec = new TextDecoder('utf-8', { fatal: false })
const enc = new TextEncoder()

// Hash normalizado (SHA-256) para provar que malha não mudou. Usamos SubtleCrypto se disponível;
// fallback: um FNV-1a determinístico sobre o mesmo buffer normalizado.
export async function normalizedModelHash(data: Uint8Array, stripPaint = false): Promise<string> {
  let buf = data
  if (stripPaint) buf = stripColorPaint(buf)
  // transform de <item ...> e metadata Application mudam no destino; zerar antes de hashear.
  let txt = dec.decode(buf)
  txt = txt.replace(/(<item\b[^>]*?)\s+transform="[^"]*"/g, '$1')
  txt = txt.replace(/(<metadata name="Application">)[^<]*/g, '$1')
  const normalized = enc.encode(txt)
  const crypto: Crypto | undefined = (globalThis as unknown as { crypto?: Crypto }).crypto
  if (crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', normalized)
    const bytes = new Uint8Array(digest)
    let s = ''
    for (const b of bytes) s += b.toString(16).padStart(2, '0')
    return s
  }
  // FNV-1a 32-bit fallback (não criptográfico, mas determinístico suficiente para parity).
  let h = 0x811c9dc5
  for (const byte of normalized) {
    h = (h ^ byte) >>> 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

const PAINT_ATTR_RE = /\s(?:paint_color|mmu_segmentation|slic3rpe:mmu_segmentation)="[^"]*"/g

export function stripColorPaint(data: Uint8Array): Uint8Array {
  const txt = dec.decode(data)
  return enc.encode(txt.replace(PAINT_ATTR_RE, ''))
}

// --------- pintura (estados usados por triângulo) ---------
export function paintStates(code: string | null | undefined): readonly number[] | null {
  if (!code) return [0]
  const nib: number[] = []
  for (const ch of code.split('').reverse()) {
    const v = parseInt(ch, 16)
    if (!Number.isFinite(v) || v < 0 || v > 15) return null
    nib.push(v)
  }
  let pos = 0, pending = 1
  const out = new Set<number>()
  while (pending > 0) {
    if (pos >= nib.length) return null
    const c = nib[pos++]
    const split = c & 3
    if (split) { pending += split }
    else {
      pending -= 1
      let st = (c >> 2) & 3
      if (st === 3) {
        if (pos >= nib.length) return null
        st = nib[pos++] + 3
      }
      out.add(st)
    }
  }
  return [...out].sort((a, b) => a - b)
}

export type ObjectScan = { n: number; cnt: Map<number, number>; comps: Array<[string, string | null]>; bad: boolean }

export async function scanModel(zip: JSZip, name: string): Promise<Record<string, ObjectScan>> {
  const bytes = await zip.file(name)!.async('uint8array')
  const txt = dec.decode(bytes)
  const objs: Record<string, ObjectScan> = {}
  let cur: ObjectScan | null = null
  const cache: Record<string, readonly number[] | null> = Object.create(null)
  let n0 = 0
  function close() { if (cur) { cur.cnt.set(0, (cur.cnt.get(0) ?? 0) + n0); n0 = 0 } }

  const tagRe = /<(object|triangle|component|\/object)\b([^>]*)>/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(txt))) {
    const kind = m[1]
    const attrs = m[2]
    if (kind === 'triangle') {
      if (!cur) continue
      cur.n += 1
      const pm = /\b(?:paint_color|mmu_segmentation)="([^"]*)"/.exec(attrs)
      if (!pm) { n0 += 1; continue }
      const code = pm[1]
      if (!(code in cache)) cache[code] = paintStates(code)
      const st = cache[code]
      if (st === null) { cur.bad = true; n0 += 1; continue }
      for (const s of st) {
        if (s === 0) n0 += 1
        else cur.cnt.set(s, (cur.cnt.get(s) ?? 0) + 1)
      }
    } else if (kind === 'object') {
      close()
      const im = /\bid="(\d+)"/.exec(attrs)
      cur = { n: 0, cnt: new Map(), comps: [], bad: false }
      n0 = 0
      if (im) objs[im[1]] = cur
      else cur = null
    } else if (kind === 'component') {
      if (!cur) continue
      const om = /\bobjectid="(\d+)"/.exec(attrs)
      const pp = /\bp:path="([^"]+)"/.exec(attrs)
      if (om) cur.comps.push([om[1], pp ? pp[1].replace(/^\//, '') : null])
    } else if (kind === '/object') {
      // close happens on next <object>; final close after loop
    }
  }
  close()
  return objs
}

export async function hasPaint(zip: JSZip, name: string): Promise<boolean> {
  const bytes = await zip.file(name)!.async('uint8array')
  const txt = dec.decode(bytes)
  return /paint_color=|mmu_segmentation/.test(txt)
}

export async function hasPaintSupports(zip: JSZip, name: string): Promise<boolean> {
  const bytes = await zip.file(name)!.async('uint8array')
  const txt = dec.decode(bytes)
  return /paint_supports="[^"]/.test(txt)
}

// --------- troca por camada ---------
export type LayerChange = { plate: string; top_z: string | null; type: string | null; extruder: string | null; color: string | null }

export function parseCustomGcode(xmlText: string): LayerChange[] | null {
  // Ultra leve: XML bem formado presumido; se falhar retornamos null.
  const out: LayerChange[] = []
  try {
    const plateRe = /<plate\b[^>]*>([\s\S]*?)<\/plate>/g
    let pm: RegExpExecArray | null
    while ((pm = plateRe.exec(xmlText))) {
      const block = pm[1]
      const infoM = /<plate_info\b[^>]*\bid="(\d+)"/.exec(block)
      const pid = infoM ? infoM[1] : '1'
      const layerRe = /<layer\b([^/>]*)(?:\/>|>)/g
      let lm: RegExpExecArray | null
      while ((lm = layerRe.exec(block))) {
        const attrs = lm[1]
        const g = (k: string) => {
          const r = new RegExp(`\\b${k}="([^"]*)"`).exec(attrs)
          return r ? r[1] : null
        }
        out.push({ plate: pid, top_z: g('top_z'), type: g('type'), extruder: g('extruder'), color: g('color') })
      }
    }
    return out
  } catch {
    return null
  }
}

export function remapCustomGcode(xmlText: string, newIndex: Map<number, number>): string {
  return xmlText.replace(/<layer\b[^>]*>/g, tag => {
    const em = /\bextruder="(\d+)"/.exec(tag)
    if (!em) return tag
    const old = parseInt(em[1], 10)
    const neu = newIndex.get(old) ?? (old === 0 ? 0 : 1)
    return tag.replace(em[0], `extruder="${neu}"`)
  })
}

const GMOVE_RE = /^\s*G0*[0-3](?![0-9])/i
const AXIS_RE = /([XYxy])\s*(-?\d*\.?\d+)/g
const NL_RE = /(\r\n|\n|&#10;|&#xA;|&#xa;|&#13;&#10;)/

export type TranslateResult = { text: string; moves: number; bbox: (number | null)[] | null; relative: boolean }

export function translateGcodeXY(code: string, dx: number, dy: number): TranslateResult {
  const parts = code.split(NL_RE)
  let absolute = true, moves = 0, rel = false
  const bb: [number, number, number, number] = [1e18, 1e18, -1e18, -1e18]
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i]
    const semi = line.indexOf(';')
    const body = semi === -1 ? line : line.slice(0, semi)
    const comment = semi === -1 ? '' : line.slice(semi)
    const u = body.trim().toUpperCase()
    if (/^G91(?![0-9])/.test(u)) { absolute = false; rel = true }
    else if (/^G90(?![0-9])/.test(u)) absolute = true
    if (!GMOVE_RE.test(body) || !absolute) continue
    let hit = false
    const nbody = body.replace(AXIS_RE, (_m, ax: string, v: string) => {
      hit = true
      const a = ax.toUpperCase()
      const nv = parseFloat(v) + (a === 'X' ? dx : dy)
      const k = a === 'X' ? 0 : 1
      if (nv < bb[k]) bb[k] = nv
      if (nv > bb[k + 2]) bb[k + 2] = nv
      const s = nv.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
      return ax + s
    })
    if (hit) {
      moves += 1
      parts[i] = nbody + comment
    }
  }
  const box: (number | null)[] | null = (bb[0] > bb[2] && bb[1] > bb[3]) ? null
    : bb.map(v => (v === 1e18 || v === -1e18) ? null : v)
  return { text: parts.join(''), moves, bbox: box, relative: rel }
}

function mergeBox(a: (number | null)[] | null, b: (number | null)[] | null): (number | null)[] {
  if (!a) return [...b!]
  const out: (number | null)[] = []
  const fns = [Math.min, Math.min, Math.max, Math.max]
  for (let i = 0; i < 4; i++) {
    const vs: number[] = []
    if (a[i] !== null && a[i] !== undefined) vs.push(a[i] as number)
    if (b && b[i] !== null && b[i] !== undefined) vs.push(b[i] as number)
    out.push(vs.length ? fns[i](...vs) : null)
  }
  return out
}

export function customGcodeXyEntries(xmlText: string): number {
  let n = 0
  const re = /<layer\b[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xmlText))) {
    const tag = m[0]
    if (!/\btype="4"/.test(tag)) continue
    const extra = /\b(?:extra|gcode)="([^"]*)"/g
    let gm: RegExpExecArray | null
    let combined = ''
    while ((gm = extra.exec(tag))) combined += ' ' + gm[1]
    const lines = combined.split(NL_RE)
    let hit = false
    for (let i = 0; i < lines.length; i += 2) {
      const body = lines[i].split(';')[0]
      if (GMOVE_RE.test(body) && AXIS_RE.test(body)) { hit = true; break }
      AXIS_RE.lastIndex = 0
    }
    if (hit) n += 1
  }
  return n
}

export type CustomGcodeStats = { moves: number; bbox: (number | null)[] | null; relative: boolean }

export function translateCustomGcode(xmlText: string, plateOffsets: Record<string, [number, number]>): { text: string; stats: Record<string, CustomGcodeStats> } {
  const stats: Record<string, CustomGcodeStats> = {}
  const text = xmlText.replace(/<plate>[\s\S]*?<\/plate>/g, block => {
    const im = /<plate_info\b[^>]*\bid="(\d+)"/.exec(block)
    const pid = im ? im[1] : '1'
    const off = plateOffsets[pid]
    if (!off) return block
    return block.replace(/<layer\b[^>]*>/g, tag => {
      if (!/\btype="4"/.test(tag)) return tag
      let modTag = tag
      let counted = false
      for (const attr of ['extra', 'gcode']) {
        const re = new RegExp(`(\\b${attr}=")([^"]*)(")`, 's')
        const em = re.exec(modTag)
        if (!em || !em[2]) continue
        const { text: nw, moves, bbox, relative } = translateGcodeXY(em[2], off[0], off[1])
        if (!moves && !relative) continue
        modTag = modTag.slice(0, em.index + em[1].length) + nw + modTag.slice(em.index + em[1].length + em[2].length)
        const st = stats[pid] ?? (stats[pid] = { moves: 0, bbox: null, relative: false })
        if (!counted) { st.moves += moves; counted = true }
        st.relative = st.relative || relative
        if (bbox) st.bbox = mergeBox(st.bbox, bbox)
      }
      return modTag
    })
  })
  return { text, stats }
}

export function dropCustomGcodeTypes(xmlText: string, types: Set<string>): { text: string; removed: number } {
  let removed = 0
  const text = xmlText.replace(/[ \t]*<layer\b[^>]*?\/>\s*\n?/g, m => {
    const tm = /\btype="(\d+)"/.exec(m)
    if (tm && types.has(tm[1])) { removed += 1; return '' }
    return m
  })
  return { text, removed }
}

// --------- analyze_filaments & related ---------
function posInt(v: unknown): number | null {
  if (v == null) return null
  const s = String(v)
  if (!/^\d+$/.test(s)) return null
  const n = parseInt(s, 10)
  return n > 0 ? n : null
}

export type FilamentAnalysis = {
  used: Set<number> | null
  why: string | null
  fixes: Map<string, number> // key = `${objId}|${partId}`
  rebase: Map<string, number>
  notes: string[]
  obj_used: Map<string, Set<number>>
  layer_changes: LayerChange[]
}

export async function analyzeFilaments(zip: JSZip, S: Record<string, unknown>, nfil: number, perFeatureKeys: readonly string[]): Promise<FilamentAnalysis> {
  const res: FilamentAnalysis = {
    used: null, why: null, fixes: new Map(), rebase: new Map(),
    notes: [], obj_used: new Map(), layer_changes: [],
  }
  const names = Object.keys(zip.files)
  if (!names.includes(MODEL_SETTINGS)) { res.why = 'sem Metadata/model_settings.config'; return res }
  const layerUsed = new Set<number>()
  if (names.includes(CUSTOM_GCODE)) {
    const xml = await zip.file(CUSTOM_GCODE)!.async('string')
    const lc = parseCustomGcode(xml)
    if (lc === null) { res.why = 'custom_gcode_per_layer.xml ilegível'; return res }
    res.layer_changes = lc
    for (const e of lc) {
      const ex = posInt(e.extruder)
      if ((e.type === '0' || e.type === '2') && ex) layerUsed.add(ex)
    }
  }
  const raw = await zip.file(MODEL_SETTINGS)!.async('string')
  // Analisar <object> blocks com regex (porta fiel ao do Python; usa <object>..</object>).
  type Part = { id: string | null; sub: string; ext: number | null; name: string }
  type Obj = { id: string | null; name: string; ext: number | null; parts: Part[] }
  const objects: Obj[] = []
  const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g
  let om: RegExpExecArray | null
  while ((om = objRe.exec(raw))) {
    const idM = /\bid="(\d+)"/.exec(om[1])
    const inner = om[2]
    const md: Record<string, string> = {}
    const topMetaRe = /<metadata\s+key="([^"]+)"\s+value="([^"]*)"/g
    const beforeParts = inner.split('<part')[0]
    let mm: RegExpExecArray | null
    while ((mm = topMetaRe.exec(beforeParts))) md[mm[1]] = mm[2]
    const parts: Part[] = []
    const partRe = /<part\b([^>]*)>([\s\S]*?)<\/part>/g
    let pm: RegExpExecArray | null
    while ((pm = partRe.exec(inner))) {
      const pid = /\bid="(\d+)"/.exec(pm[1])?.[1] ?? null
      const sub = /\bsubtype="([^"]+)"/.exec(pm[1])?.[1] ?? 'normal_part'
      const partMeta: Record<string, string> = {}
      const metaRe = /<metadata\s+key="([^"]+)"\s+value="([^"]*)"/g
      let qm: RegExpExecArray | null
      while ((qm = metaRe.exec(pm[2]))) partMeta[qm[1]] = qm[2]
      parts.push({ id: pid, sub, ext: posInt(partMeta.extruder), name: partMeta.name ?? md.name ?? '' })
    }
    objects.push({ id: idM ? idM[1] : null, name: md.name ?? '', ext: posInt(md.extruder), parts })
  }
  if (!objects.length) { res.why = 'nenhum objeto em model_settings.config'; return res }

  const models = names.filter(n => /\.model$/i.test(n))
  const painted = new Set<string>()
  for (const n of models) if (await hasPaint(zip, n)) painted.add(n)
  const scans: Record<string, Record<string, ObjectScan>> = {}
  if (painted.size) {
    for (const n of new Set([ROOT_MODEL, ...painted])) {
      if (names.includes(n)) scans[n] = await scanModel(zip, n)
    }
    for (const sc of Object.values(scans)) for (const ob of Object.values(sc)) {
      if (ob.bad) { res.why = 'pintura de cor ilegível'; return res }
    }
  }

  function volumeHist(o: Obj, p: Part, sole: boolean): Map<number, number> | null {
    if (!painted.size) return null
    const ro = scans[ROOT_MODEL]?.[o.id!]
    if (!ro) throw new Error('UNRESOLVED')
    if (ro.comps.length && p.id !== null) {
      for (const [cid, path] of ro.comps) {
        if (cid === p.id) {
          const fname = path ?? ROOT_MODEL
          if (!painted.has(fname)) return null
          const so = scans[fname]?.[cid]
          if (!so) throw new Error('UNRESOLVED')
          return so.cnt
        }
      }
      throw new Error('UNRESOLVED')
    }
    if (ro.n) {
      if (!painted.has(ROOT_MODEL)) return null
      if (sole) return ro.cnt
      throw new Error('UNRESOLVED')
    }
    throw new Error('UNRESOLVED')
  }

  const used = new Set<number>()
  const mappedStates = new Set<number>()
  try {
    for (const o of objects) {
      const parts: Part[] = o.parts.length ? o.parts : [{ id: null, sub: 'normal_part', ext: null, name: o.name }]
      const normal = parts.filter(p => p.sub === 'normal_part')
      const ou = new Set<number>()
      for (const p of parts) {
        if (p.sub === 'modifier_part') {
          if (p.ext) ou.add(p.ext)
          continue
        }
        if (p.sub !== 'normal_part') continue
        const base = p.ext ?? o.ext ?? 1
        const hist = volumeHist(o, p, normal.length === 1)
        const states = new Set<number>()
        if (hist) for (const [s, c] of hist.entries()) if (s > 0 && c > 0) states.add(s)
        for (const s of states) mappedStates.add(s)
        const unpainted = !hist || (hist.get(0) ?? 0) > 0 || !states.size
        if (unpainted) {
          for (const s of states) ou.add(s)
          ou.add(base)
        } else {
          let pick = -1, bestCount = -1
          for (const s of states) {
            const c = hist!.get(s) ?? 0
            if (c > bestCount || (c === bestCount && pick > s)) { pick = s; bestCount = c }
          }
          if (pick !== base && layerUsed.size === 0) {
            res.fixes.set(`${o.id}|${p.id ?? ''}`, pick)
            if (normal.length === 1) res.rebase.set(o.id!, pick)
            res.notes.push(`Objeto "${p.name || o.name}" está todo pintado com o filamento ${pick}, mas a base era o filamento ${base} (que não imprimiria nada): a base passou a ser ${pick}.`)
          }
          for (const s of states) ou.add(s)
          if (layerUsed.size) ou.add(base)
        }
      }
      res.obj_used.set(o.id!, ou)
      for (const v of ou) used.add(v)
    }
  } catch (e) {
    if (!(e instanceof Error) || e.message !== 'UNRESOLVED') throw e
    res.fixes.clear(); res.rebase.clear(); res.notes.length = 0
    res.why = 'não foi possível casar a pintura com os objetos'
    return res
  }
  const every = new Set<number>()
  for (const sc of Object.values(scans)) for (const ob of Object.values(sc)) for (const [s, c] of ob.cnt.entries()) if (s > 0 && c > 0) every.add(s)
  for (const s of every) if (!mappedStates.has(s)) {
    res.fixes.clear(); res.rebase.clear(); res.notes.length = 0
    res.why = 'pintura de cor fora de qualquer objeto imprimível'
    return res
  }
  // per_feature_filament_keys referenciados em model_settings
  const keysAlt = perFeatureKeys.join('|')
  const metaRe = new RegExp(`<metadata\\s+key="(?:${keysAlt})"\\s+value="(\\d+)"`, 'g')
  let mr: RegExpExecArray | null
  while ((mr = metaRe.exec(raw))) {
    const n = parseInt(mr[1], 10)
    if (n > 0) used.add(n)
  }
  for (const k of perFeatureKeys) {
    const raw = S[k]
    const first = Array.isArray(raw) ? raw[0] : raw
    const n = first == null ? null : Number(first)
    if (Number.isFinite(n!) && (n as number) > 0) used.add(n as number)
  }
  for (const v of layerUsed) used.add(v)
  used.delete(0)
  if (!used.size || Math.max(...used) > nfil) {
    res.fixes.clear(); res.rebase.clear(); res.notes.length = 0
    res.why = 'números de filamento fora da lista do projeto'
    return res
  }
  res.used = used
  if (res.notes.length > 3) {
    res.notes = [`${res.notes.length} objetos estavam todos pintados com outro filamento que não a base; a base foi ajustada para o filamento pintado.`]
  }
  return res
}

export function remapModelSettings(xml: string, keep: number[], perFeatureKeys: readonly string[]): string {
  const neu: Record<string, string> = {}
  keep.forEach((old, i) => neu[String(old)] = String(i + 1))
  const n = keep.length
  const keys = ['extruder', ...perFeatureKeys].join('|')
  let out = xml.replace(new RegExp(`(<metadata\\s+key="(?:${keys})"\\s+value=")(\\d+)(")`, 'g'),
    (_m, a: string, v: string, c: string) => a + (neu[v] ?? (v === '0' ? '0' : '1')) + c)
  out = out.replace(/(<metadata\s+key="filament_maps"\s+value=")[^"]*(")/g,
    (_m, a: string, c: string) => a + Array(n).fill('1').join(' ') + c)
  out = out.replace(/(<metadata\s+key="filament_volume_maps"\s+value=")[^"]*(")/g,
    (_m, a: string, c: string) => a + Array(n).fill('0').join(' ') + c)
  return out
}

export function rebaseExtruders(xml: string, fixes: Map<string, number>, rebase: Map<string, number>): string {
  return xml.replace(/<object\b([^>]*)\bid="(\d+)"([^>]*)>([\s\S]*?)<\/object>/g, (_m, pre: string, oid: string, post: string, body: string) => {
    let block = body
    for (const [k, f] of fixes) {
      const [o, pid] = k.split('|')
      if (o !== oid || !pid) continue
      const partRe = new RegExp(`(<part\\b[^>]*\\bid="${pid}"[^>]*>)([\\s\\S]*?)(</part>)`)
      block = block.replace(partRe, (_match, start: string, inner: string, end: string) => {
        let newInner = inner
        if (/<metadata\s+key="extruder"/.test(newInner)) {
          newInner = newInner.replace(/(<metadata\s+key="extruder"\s+value=")\d+(")/, (_mm, a: string, c: string) => a + f + c)
        } else {
          newInner = '\n      <metadata key="extruder" value="' + f + '"/>' + newInner
        }
        return start + newInner + end
      })
    }
    if (rebase.has(oid)) {
      const parts = block.split('<part')
      let head = parts[0]
      head = head.replace(/(<metadata\s+key="extruder"\s+value=")\d+(")/, (_mm, a: string, c: string) => a + rebase.get(oid) + c)
      block = head + (parts.length > 1 ? '<part' + parts.slice(1).join('<part') : '')
    }
    return `<object${pre} id="${oid}"${post}>${block}</object>`
  })
}

export function mirrorObjectKeys(xml: string, keys: Record<string, string>): string {
  return xml.replace(/<object\b[^>]*>[\s\S]*?<\/object>/g, block => {
    let add = ''
    for (const [k, v] of Object.entries(keys)) {
      if (!new RegExp(`key="${k}"`).test(block)) add += `    <metadata key="${k}" value="${v}"/>\n`
    }
    if (!add) return block
    const idx = block.lastIndexOf('</object>')
    return block.slice(0, idx) + add + '  </object>'
  })
}

export function stripPlateBedType(xml: string): string {
  return xml.replace(/\s*<metadata\s+key="(?:bed_type|curr_bed_type)"\s+value="[^"]*"\s*\/>/g, '')
}

type PlateInstance = { objectId: string; instanceIndex: number | null }

function plateMetadata(xml: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const [tag] of xml.matchAll(/<metadata\b[^>]*>/g)) {
    const key = /\skey\s*=\s*["']([^"']*)["']/.exec(tag)?.[1]
    const value = /\svalue\s*=\s*["']([^"']*)["']/.exec(tag)?.[1]
    if (key !== undefined && value !== undefined) values.set(key, value)
  }
  return values
}

export function parsePlates(msXml: string): Map<number, PlateInstance[]> | null {
  const plates = new Map<number, PlateInstance[]>()
  for (const [, block] of msXml.matchAll(/<plate\b[^>]*>([\s\S]*?)<\/plate>/g)) {
    const rawId = plateMetadata(block).get('plater_id')
    const id = rawId === undefined ? plates.size + 1 : Number(rawId)
    if (!Number.isSafeInteger(id) || id < 1 || plates.has(id)) return null
    const instances: PlateInstance[] = []
    for (const [, entry] of block.matchAll(/<model_instance\b[^>]*>([\s\S]*?)<\/model_instance>/g)) {
      const metadata = plateMetadata(entry)
      const objectId = metadata.get('object_id')
      const instanceId = metadata.get('instance_id')
      if (!objectId || !/^\d+$/.test(objectId)) continue
      if (instanceId !== undefined && !/^\d+$/.test(instanceId)) return null
      instances.push({ objectId, instanceIndex: instanceId === undefined ? null : Number(instanceId) })
    }
    plates.set(id, instances)
  }
  return plates
}

export function cleanRels(xmlText: string, removed: string[]): string {
  const absSet = new Set<string>([...removed, ...removed.map(r => '/' + r)])
  return xmlText.replace(/\s*<Relationship\b[^>]*\/>/g, m => {
    const tg = /Target="([^"]+)"/.exec(m)
    return tg && absSet.has(tg[1]) ? '' : m
  })
}

// --------- geometria (bbox) ---------
type Local = ['mesh', number[]] | ['comp', Array<[string, string, Matrix12]>]

async function readLocalBboxes(zip: JSZip, name: string): Promise<Record<string, Local>> {
  const bytes = await zip.file(name)!.async('uint8array')
  const txt = dec.decode(bytes)
  const out: Record<string, Local> = {}
  let curId: string | null = null
  let cur: { bb: number[] | null; comps: Array<[string, string, Matrix12]> } | null = null
  const tokenRe = /<object\b([^>]*)>|<component\b([^>]*)\/?>|<\/object>|<vertex\b[^>]*\/>/g
  const vertexAttrRe = /\bx="([^"]+)"[\s\S]*?\by="([^"]+)"[\s\S]*?\bz="([^"]+)"/
  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(txt))) {
    const tok = m[0]
    if (tok.startsWith('<object')) {
      const im = /\bid="(\d+)"/.exec(m[1] ?? '')
      curId = im ? im[1] : null
      cur = { bb: null, comps: [] }
    } else if (tok.startsWith('</object')) {
      if (curId && cur) {
        out[curId] = (cur.comps.length && cur.bb === null) ? ['comp', cur.comps] : ['mesh', cur.bb ?? []]
      }
      curId = null; cur = null
    } else if (tok.startsWith('<component') && cur) {
      const attrs = m[2] ?? ''
      const om = /\bobjectid="(\d+)"/.exec(attrs)
      const tr = /\btransform="([^"]*)"/.exec(attrs)
      const pp = /\bp:path="([^"]+)"/.exec(attrs)
      if (om) cur.comps.push([om[1], pp ? pp[1].replace(/^\//, '') : name, tfParse(tr ? tr[1] : '')])
    } else if (cur) {
      const vm = vertexAttrRe.exec(tok)
      if (vm) {
        const x = parseFloat(vm[1]), y = parseFloat(vm[2]), z = parseFloat(vm[3])
        const b = cur.bb
        if (!b) cur.bb = [x, y, z, x, y, z]
        else {
          if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (z < b[2]) b[2] = z
          if (x > b[3]) b[3] = x; if (y > b[4]) b[4] = y; if (z > b[5]) b[5] = z
        }
      }
    }
  }
  return out
}

export type BBox6 = [number, number, number, number, number, number]

type BuildItem = { index: number; objectId: string; bbox?: BBox6 }

export function mapBuildItems(xml: string, mapItem: (tag: string, index: number) => string): string {
  return xml.replace(BUILD_RE, (_match, open: string, body: string, close: string) => {
    let index = 0
    return open + body.replace(BUILD_ITEM_RE, tag => mapItem(tag, index++)) + close
  })
}

export async function itemBboxes(zip: JSZip): Promise<BuildItem[]> {
  const cache = new Map<string, Record<string, Local>>()
  async function objs(path: string) {
    if (!cache.has(path)) {
      cache.set(path, zip.file(path) ? await readLocalBboxes(zip, path) : {})
    }
    return cache.get(path)!
  }
  function corners(bb: number[]): Array<[number, number, number]> {
    const [x0, y0, z0, x1, y1, z1] = bb
    const out: Array<[number, number, number]> = []
    for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) out.push([x, y, z])
    return out
  }
  async function walk(path: string, oid: string, tf: Matrix12, pts: Array<[number, number, number]>, depth = 0): Promise<void> {
    if (depth > 16) return
    const kind = (await objs(path))[oid]
    if (!kind) return
    if (kind[0] === 'mesh' && kind[1].length) {
      for (const c of corners(kind[1] as number[])) pts.push(tfApply(tf, c[0], c[1], c[2]))
    } else if (kind[0] === 'comp') {
      for (const [cid, cpath, ctf] of kind[1]) {
        await walk(cpath, cid, tfMul(ctf, tf), pts, depth + 1)
      }
    }
  }
  const txt = dec.decode(await zip.file(ROOT_MODEL)!.async('uint8array'))
  const out: BuildItem[] = []
  const build = BUILD_RE.exec(txt)?.[2] ?? ''
  let index = -1
  for (const [tag] of build.matchAll(BUILD_ITEM_RE)) {
    index++
    const objectId = /objectid="(\d+)"/.exec(tag)?.[1]
    if (!objectId) continue
    const transform = /transform="([^"]*)"/.exec(tag)?.[1]
    const pts: Array<[number, number, number]> = []
    await walk(ROOT_MODEL, objectId, tfParse(transform), pts)
    const item: BuildItem = { index, objectId }
    if (pts.length) {
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), zs = pts.map(p => p[2])
      item.bbox = [Math.min(...xs), Math.min(...ys), Math.min(...zs), Math.max(...xs), Math.max(...ys), Math.max(...zs)]
    }
    out.push(item)
  }
  return out
}

export function unionBbox(boxes: (BBox6 | undefined)[]): BBox6 | null {
  const bs = boxes.filter((b): b is BBox6 => !!b)
  if (!bs.length) return null
  return [
    Math.min(...bs.map(b => b[0])), Math.min(...bs.map(b => b[1])), Math.min(...bs.map(b => b[2])),
    Math.max(...bs.map(b => b[3])), Math.max(...bs.map(b => b[4])), Math.max(...bs.map(b => b[5])),
  ]
}
