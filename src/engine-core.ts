// Porta de convert/flashforge/engine.py (v0.2.3).
// Lógica adaptada de iChristGit/3MF-to-AD5X (MIT) e generalizada para múltiplas impressoras
// Flashforge pelo projeto Extruvo. Mantido o mesmo princípio: copiar a metade "autor",
// trocar a metade "máquina" por um template Flashforge e reconstruir different_settings_to_system.
//
// `engine-core.ts` NÃO importa o registro estático de impressoras (printers.ts).
// Isso permite que o worker em lazy-load só carregue o chunk da impressora
// selecionada em tempo de execução. O caminho síncrono (testes/Node) usa
// `engine.ts`, que embrulha esta função injetando o `Printer` via `getPrinter`.
import JSZip from 'jszip'
import * as M from './model3mf'
import { SETTINGS, detect } from './detect'
import { loadMapping, type Mapping, type ProjectSettings } from './mapping'
import { Printer } from './printers-core'
import { first, fmt, num, parseArea, plateOrigin, resize, type Area } from './util'
import { validateOutput, type ValidationContext } from './validate'

export { Printer } from './printers-core'

export const ENGINE_VERSION = '0.2.8'
export const BED_KEY_BY_TYPE: Record<string, string> = {
  'Cool Plate': 'cool_plate_temp', 'Engineering Plate': 'eng_plate_temp',
  'High Temp Plate': 'hot_plate_temp', 'Textured PEI Plate': 'textured_plate_temp',
  'Textured Cool Plate': 'textured_cool_plate_temp', 'Supertack Plate': 'supertack_plate_temp',
}
const MULTI_COLOUR_DEFAULT = '#26A69A'
const SPEED_KEYS = ['sparse_infill_speed', 'internal_solid_infill_speed', 'gap_infill_speed'] as const
const COLOR_RE = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/
const FEATURE_MIN1_KEYS = new Set(['wall_filament', 'sparse_infill_filament', 'solid_infill_filament'])
// OrcaSlicer 2.5 só aceita retraction_distances_when_cut em [10, 18]. O perfil
// oficial Creality coloca 30 (K2 0.4, Sermoon M300 0.4) e 28 (SPARKX i7 todos)
// nas máquinas de uma extrusora que o Orca 2.5 recusa com exit 238. Clamp
// defensivo (só para esta chave) grava 18, valor válido e já usado pelas
// variantes irmãs 0.6 / 0.8 do mesmo perfil. Documentado em NOTICE.
const RETRACTION_DISTANCES_WHEN_CUT_RANGE: [number, number] = [10, 18]
// Chaves alinhadas ao FILAMENTO (não ao toolhead). Confirmado contra o 3MF
// single_color oficial exportado pelo Flash Studio 1.7.9 (box, AppImage,
// 2026-11-14): perfil oficial "Flashforge Creator 5 Pro 0.4 nozzle.json"
// (machine) + "0.20mm Standard @FF C5.json" (process) + "Flashforge PLA
// Basic @FF C5P.json" (filament), `--slice 0 --allow-mix-temp
// --export-3mf`, exit 0. O project_settings do 3MF gerado traz:
//   nozzle_volume_type          ["Standard"]
//   filament_extruder_variant   ["Direct Drive Standard"]
//   filament_map                ["1"]
// e no multicolor_4 oficial (nfil=4) as três têm 4 entradas.
//
// Regra correta (2026-11-14, revisão da revisão):
//   filament_extruder_variant  length = nfil
//   filament_map               length = nfil
//   nozzle_volume_type         length = min(nfil, toolheads)
//
// nozzle_volume_type bate com `default_nozzle_volume_type` por posição de
// toolhead (uma entrada por bico físico). Em máquinas 1-toolhead + 4
// filamentos (AD5X, Creality Ender-3 0.2) o oficial / perfil upstream
// traz nvt length 1 e o Orca 2.5 reclama de "Prime tower is partially
// outside the printable area" (exit 156) quando enviamos length 4.
// Expansão errada para toolheads na Creator 5 / 5 Pro (4-toolhead) em
// single_color fazia o Flash Studio buscar extruder_type/nozzle_volume_type
// para extruder_index 2/3/4 e abortar com SIGSEGV (exit 139). Arrays
// por-extrusora da máquina (nozzle_diameter, printer_extruder_id,
// extruder_type, default_nozzle_volume_type, deretraction_speed,
// extruder_offset, etc.) continuam com length = toolheads e não entram
// nesta lista.
type FilamentAlignedKey = { key: string; pad: string; cap: 'nfil' | 'min_nfil_toolheads' }
const FILAMENT_ALIGNED_KEYS: ReadonlyArray<FilamentAlignedKey> = [
  { key: 'nozzle_volume_type', pad: 'Standard', cap: 'min_nfil_toolheads' },
  { key: 'filament_extruder_variant', pad: 'Direct Drive Standard', cap: 'nfil' },
  { key: 'filament_map', pad: '1', cap: 'nfil' },
]

// Chaves POR FILAMENTO que o Flash Studio (Orca-Flashforge 2.4.2) indexa por filamento em
// máquinas multi-bico (Creator 5 / 5 Pro) e que o perfil oficial só declara nos filamentos
// "Elastic". Sem uma entrada por filamento o fatiador registra, para cada filamento extra,
// "option <chave> variant index N out of range, skipping". O valor gravado é o padrão da
// fatiador para a opção — conferido no projeto que o próprio Flash Studio CLI exporta com os
// perfis oficiais (artifacts/goal-2026-11-20/probe/official-c5: 1, 1 e 10) — então o
// comportamento do fatiamento não muda, só some o aviso.
const MULTI_TOOLHEAD_FILAMENT_DEFAULTS: Readonly<Record<string, string>> = {
  activate_air_filtration_during_print: '1',
  activate_air_filtration_on_completion: '1',
  filament_cooling_before_tower: '10',
}
// Estilos de suporte em árvore que o Flash Studio/Orca resolvem como ORGÂNICO.
const ORGANIC_TREE_STYLES: readonly string[] = ['default', 'tree_organic']

type Rect = { x0: number; y0: number; x1: number; y1: number; h: number }
function rectDistance(a: Rect, b: Rect): number {
  const dx = Math.max(0, a.x0 - b.x1, b.x0 - a.x1)
  const dy = Math.max(0, a.y0 - b.y1, b.y0 - a.y1)
  return Math.hypot(dx, dy)
}
function addProcessDiff(R: ProjectSettings, key: string): void {
  const diff = R.different_settings_to_system as string[] | undefined
  if (!Array.isArray(diff) || !diff.length) return
  const procSlot = String(diff[0]).split(';').filter(Boolean)
  if (procSlot.includes(key)) return
  procSlot.push(key)
  procSlot.sort()
  diff[0] = procSlot.join(';')
}

// O project_settings.config do Bambu/Orca/Flash Studio guarda TODOS os valores como texto
// (ou lista de textos). Arquivos reescritos por outras ferramentas podem trazer números e
// booleanos JSON; o Flash Studio recusa a chave ("invalid json type for layer_height") e
// volta ao padrão em silêncio. Aqui o tipo é normalizado sem mudar o valor.
function stringifySettingValues(R: ProjectSettings, rep: ConversionReport): ProjectSettings {
  const fixed: string[] = []
  const one = (v: unknown): unknown => {
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '0'
    if (typeof v === 'boolean') return v ? '1' : '0'
    return v
  }
  const out: ProjectSettings = {}
  for (const [k, v] of Object.entries(R)) {
    const nv = Array.isArray(v) ? v.map(one) : one(v)
    if (JSON.stringify(nv) !== JSON.stringify(v)) fixed.push(k)
    out[k] = nv
  }
  if (fixed.length) rep.notes.push(`Valores numéricos/booleanos gravados como texto, como o fatiador exige: ${fixed.slice(0, 12).join(', ')}${fixed.length > 12 ? ' ...' : ''}.`)
  return out
}

export class ConversionError extends Error {
  readonly report: ConversionReport
  readonly code: string
  constructor(message: string, report?: ConversionReport, code = 'conversion_failed') {
    super(message)
    this.name = 'ConversionError'
    this.report = report ?? newReport(null, '')
    this.code = code
  }
}

export type Renamed = { from: string; to: string }
export type Discarded = { key: string; reason: string }
export type Capped = { key: string; from: string; to: string; limit: string }
export type SpeedRow = { key: string; from: string; to: string; status: string }
export type AuthorCustomised = { key: string; carried: boolean }
export type FilamentRow = { slot: number; original: number; color: unknown; type: string; preset: string; nozzle_temp: unknown }
export type PlateRow = {
  id: number
  shift_mm: [number, number]
  prime_tower_local: (number | null)[]
  fits: boolean
  size_mm?: [number, number]
}

export type ConversionReport = {
  engine: { name: string; version: string }
  ok: boolean
  input: Record<string, unknown>
  printer: Record<string, unknown>
  kept: string[]
  renamed: Renamed[]
  replaced: string[]
  discarded: Discarded[]
  not_in_target: string[]
  capped: Capped[]
  speeds: SpeedRow[]
  author_customised: AuthorCustomised[]
  warnings: string[]
  notes: string[]
  errors: string[]
  filaments: FilamentRow[]
  plates: PlateRow[]
  removed_files: string[]
  preserved: Record<string, unknown>
  validation: { ok?: boolean; checks?: unknown[]; warnings?: string[] }
  pending: string[]
  status: string
  output?: { file: string; bytes: number }
  summary?: Record<string, number | string>
}

function newReport(printer: Printer | null, srcName: string): ConversionReport {
  return {
    engine: { name: 'extruvo-flashforge-converter', version: ENGINE_VERSION },
    ok: false, input: { file: srcName }, printer: printer ? printer.public() : {},
    kept: [], renamed: [], replaced: [], discarded: [], not_in_target: [],
    capped: [], speeds: [], author_customised: [], warnings: [], notes: [], errors: [],
    filaments: [], plates: [], removed_files: [], preserved: {}, validation: {},
    pending: [], status: 'falhou',
  }
}

function safeColor(c: unknown): string | null {
  return typeof c === 'string' && COLOR_RE.test(c) ? c : null
}

function extruderCount(R: ProjectSettings): number {
  const nd = R.nozzle_diameter
  if (Array.isArray(nd) && nd.length) return nd.length
  const pe = R.printer_extruder_id
  if (Array.isArray(pe) && pe.length) return pe.length
  return 1
}

// Alinha as três chaves indexadas por filamento. filament_extruder_variant
// e filament_map têm length = nfil. nozzle_volume_type bate por POSIÇÃO DE
// TOOLHEAD com `default_nozzle_volume_type`, então o alvo é
// min(nfil, toolheads): em máquinas 1-toolhead + nfil>1 (AD5X, Ender-3 0.2)
// fica length 1 (= perfil oficial upstream, cabe no Orca 2.5); em
// máquinas 4-toolhead + nfil=1 (Creator 5 / 5 Pro single_color) fica
// length 1 (= 3MF oficial Flash Studio 1.7.9, evita o SIGSEGV por indexar
// extruder_index 2/3/4). Trim se o template tiver mais entradas, pad
// nunca além do alvo. Não toca default_nozzle_volume_type ou qualquer
// outra array por-extrusora da máquina.
function alignFilamentKeysToNfil(R: ProjectSettings, nfil: number, rep: ConversionReport): void {
  const toolheads = extruderCount(R)
  for (const { key, pad, cap } of FILAMENT_ALIGNED_KEYS) {
    const target = cap === 'nfil' ? nfil : Math.min(nfil, toolheads)
    const v = R[key]
    if (!Array.isArray(v)) {
      R[key] = Array(target).fill(pad)
      continue
    }
    if (v.length === target) continue
    let arr: unknown[]
    if (v.length > target) {
      arr = v.slice(0, target)
    } else {
      arr = [...v]
      const last = arr.length ? arr[arr.length - 1] : pad
      while (arr.length < target) arr.push(last)
    }
    R[key] = arr
    const anchor = cap === 'nfil' ? 'nº de filamentos' : 'min(nº de filamentos, nº de toolheads)'
    rep.notes.push(`${key}: ${v.length} → ${target} entradas (= ${anchor}; alinhamento ao 3MF oficial do Flash Studio 1.7.9).`)
  }
}

function clampRetractionDistancesWhenCut(R: ProjectSettings, rep: ConversionReport): void {
  const key = 'retraction_distances_when_cut'
  const v = R[key]
  if (v === undefined || v === null) return
  const [lo, hi] = RETRACTION_DISTANCES_WHEN_CUT_RANGE
  const sanitizeOne = (raw: unknown): unknown => {
    if (raw === null || raw === undefined) return raw
    const parts = String(raw).split(',').map(s => s.trim())
    const normalized = parts.map(part => {
      const n = num(part)
      if (n === null) return part
      if (n < lo) return String(lo)
      if (n > hi) return String(hi)
      return part
    })
    return normalized.join(',')
  }
  const beforeArr = Array.isArray(v) ? v : [v]
  const afterArr = beforeArr.map(sanitizeOne)
  const changed = afterArr.some((x, i) => String(x) !== String(beforeArr[i]))
  if (changed) {
    R[key] = Array.isArray(v) ? afterArr : afterArr[0]
    const samples: string[] = []
    for (let i = 0; i < beforeArr.length && samples.length < 4; i++) {
      const a = String(beforeArr[i]), b = String(afterArr[i])
      if (a !== b) samples.push(`${a}→${b}`)
    }
    rep.notes.push(`retraction_distances_when_cut: clamp para [${lo}, ${hi}] (limite do OrcaSlicer 2.5): ${samples.join(', ')}.`)
  }
}

// FIX 2 (crítico): o Orca 2.5 lê retraction_distances_when_cut do 3MF mas se
// a chave não aparecer no SLOT DE MÁQUINA de different_settings_to_system
// (último slot), reverte para o valor do perfil oficial Creality.opc (30 em
// K2 0.4 / Sermoon M300 0.4; 28 em SPARKX i7) — resultado: `18 -> 30` e
// exit 238. Marcamos a chave como customizada na máquina para perfis que
// serão fatiados pelo Orca (Creality). Flashforge usa Flash Studio, não
// Orca; mantemos paridade com o Python v0.2.3 ali. Divergência explícita
// documentada no NOTICE.
// Aviso (não-mutador) quando o 3MF de saída combina a receita clássica de
// "suporte colou no modelo e galho oco colapsou":
//   - support_type começa com `tree` (tree(auto)/tree_organic/tree)
//   - support_top_z_distance ≤ layer_height (interface solda no modelo)
//   - tree_support_wall_count == 0 (galho oco em zigue-zague)
//   - detect_thin_wall == 0 (paredes finas do modelo podem virar gap-fill)
// Todas as três condições precisam estar simultaneamente presentes (foi
// essa exatamente a combinação do caso Spider-Man Noir Creator 5 Pro,
// 2026-11-16). Se sim e a malha não trouxer paint_supports para bloquear
// áreas delicadas, soma-se essa quarta observação ao texto. A função NÃO
// altera as configurações do autor — só emite warning + pending.
function warnRiskySupportCombo(R: ProjectSettings, rep: ConversionReport, hasPaintSupports: boolean): void {
  if (String(first(R.enable_support ?? '0')) !== '1') return
  const supportType = String(first(R.support_type ?? '')).toLowerCase()
  if (!supportType.startsWith('tree')) return
  const topZ = num(first(R.support_top_z_distance ?? '0.2')) ?? 0.2
  const lh = num(first(R.layer_height ?? '0.2')) ?? 0.2
  const wallCount = num(first(R.tree_support_wall_count ?? '0')) ?? 0
  const thinWall = String(first(R.detect_thin_wall ?? '0'))
  const topZRisk = topZ <= lh + 1e-9
  const wallRisk = wallCount <= 0
  const thinRisk = thinWall === '0'
  if (!(topZRisk && wallRisk && thinRisk)) return
  const parts = [
    `support_top_z_distance=${topZ} ≤ layer_height=${lh} (interface solda no modelo)`,
    `tree_support_wall_count=${wallCount} (galho oco)`,
    'detect_thin_wall=0 (paredes finas do modelo podem virar gap-fill)',
  ]
  if (!hasPaintSupports) parts.push('sem paint_supports na malha (suporte automático em áreas delicadas)')
  const msg = `Combinação de risco em suporte em árvore: ${parts.join('; ')}. Nenhuma configuração do autor foi alterada; antes de imprimir, considere afrouxar top_z_distance (0.20), dar 1 parede ao galho (tree_support_wall_count=1) e pintar suporte nas áreas delicadas (dedos/pontas).`
  rep.warnings.push(msg)
  rep.pending.push(msg)
}

// Aviso (não-mutador) quando o preset do autor usa parede clássica com 2 ou
// menos loops e sem detecção de parede fina. Flash Studio 1.7.21 e Orca 2.5
// deixam `gap_infill` (linhas soltas) nas regiões onde 2× `outer_wall_line_width`
// não cabe (ex.: braço fino ~0,8 mm no Spider-Man Noir). Com
// `wall_generator=arachne` + `detect_thin_wall=1` + `min_bead_width≈70%` o
// slicer usa paredes de largura variável e preenche a região (medido 2026-11-16:
// `gap_infill` no braço cai de 3147,9 mm para 27,4 mm, -99,1 %). A função não
// altera as configurações do autor — só emite warning + pending.
function warnThinWallCombo(R: ProjectSettings, rep: ConversionReport): void {
  const gen = String(first(R.wall_generator ?? '')).toLowerCase()
  if (gen !== 'classic') return
  const loops = num(first(R.wall_loops ?? '2')) ?? 2
  if (loops > 2) return
  const thin = String(first(R.detect_thin_wall ?? '0'))
  if (thin !== '0') return
  const owLw = num(first(R.outer_wall_line_width ?? '0.42')) ?? 0.42
  if (owLw < 0.4) return
  const msg = `Combinação de risco em parede fina: wall_generator=classic; wall_loops=${loops}; detect_thin_wall=0; outer_wall_line_width=${owLw} mm. Regiões abaixo de ${(loops * owLw).toFixed(2)} mm (ex.: braços/dedos finos) podem sair com "linhas soltas" (gap_infill). Nenhuma configuração do autor foi alterada; para fechar essas paredes no Flash Studio/Orca considere no fatiador wall_generator=arachne + detect_thin_wall=1 + min_bead_width=70%.`
  rep.warnings.push(msg)
  rep.pending.push(msg)
}

function markRetractionDistancesInMachineSlot(R: ProjectSettings, printer: Printer): void {
  if (!('retraction_distances_when_cut' in R)) return
  const model = String(printer.meta.printer_model ?? '')
  if (!model.startsWith('Creality')) return
  const d = R.different_settings_to_system
  if (!Array.isArray(d) || !d.length) return
  const lastIdx = d.length - 1
  const slot = String(d[lastIdx] ?? '')
  const keys = new Set(slot.split(';').filter(Boolean))
  if (keys.has('retraction_distances_when_cut')) return
  keys.add('retraction_distances_when_cut')
  d[lastIdx] = [...keys].sort().join(';')
}

function sanitizeColors(R: ProjectSettings, rep: ConversionReport) {
  const bad: string[] = []
  for (const k of ['filament_colour', 'extruder_colour', 'default_filament_colour']) {
    const v = R[k]
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const c = v[i]
        if ((c === '' || c === null || c === undefined) && k !== 'filament_colour') continue
        if (!safeColor(c)) { bad.push(`${k}[${i + 1}]`); v[i] = '#FFFFFF' }
      }
    } else if (typeof v === 'string' && v && !safeColor(v)) {
      bad.push(k); R[k] = '#FFFFFF'
    }
  }
  if (bad.length) {
    rep.warnings.push('Cor(es) inválida(s) no arquivo de origem substituída(s) por #FFFFFF: ' + bad.slice(0, 8).join(', ') + '. O arquivo pode estar corrompido ou adulterado.')
  }
}

function filVector(v: unknown[], nfil: number, selfIndex: unknown[], variants: unknown[]): unknown[] {
  if (v.length === selfIndex.length && selfIndex.length > nfil) {
    const out: unknown[] = []
    for (let fid = 1; fid <= nfil; fid++) {
      const idx: number[] = []
      for (let j = 0; j < selfIndex.length; j++) if (parseInt(String(selfIndex[j]), 10) === fid) idx.push(j)
      const pick = idx.find(j => variants[j] === 'Direct Drive Standard') ?? (idx.length ? idx[0] : 0)
      out.push(v[pick])
    }
    return out
  }
  const trimmed = v.slice(0, nfil)
  if (!trimmed.length) return trimmed
  while (trimmed.length < nfil) trimmed.push(trimmed[trimmed.length - 1])
  return trimmed
}

function adaptValue(mp: Mapping, key: string, sv: unknown, tv: unknown, nfil: number, si: unknown[], fv: unknown[]): unknown {
  if (mp.keepAuthorShape.has(key) && Array.isArray(sv) && !Array.isArray(tv)) return sv
  if (Array.isArray(tv)) {
    if (Array.isArray(sv)) {
      if (mp.filamentOpts.has(key)) return filVector(sv, nfil, si, fv)
      return sv.slice(0, Math.max(tv.length, 1))
    }
    return Array(mp.filamentOpts.has(key) ? nfil : tv.length).fill(sv)
  }
  return first(sv as unknown)
}

function slowerAuthorSpeeds(mp: Mapping, S: ProjectSettings, T: ProjectSettings): Record<string, number> {
  const sd = S.different_settings_to_system
  if (!Array.isArray(sd) || !sd.length) return {}
  const out: Record<string, number> = {}
  for (const k of String(sd[0]).split(';')) {
    if (!k) continue
    const tk = mp.targetKey(k)
    if (!tk.endsWith('_speed') || mp.notMotion.has(tk) || !(k in S)) continue
    const a = first(S[k] as unknown)
    const b = tk in T ? first(T[tk] as unknown) : null
    if (a == null || b == null || String(a).endsWith('%') || String(b).endsWith('%')) continue
    const na = num(a), nb = num(b)
    if (na !== null && nb !== null && na > 0 && na < nb) out[tk] = na
  }
  return out
}

function speedsForLayer(printer: Printer, lh: number): [Record<string, string>, string | null] {
  const raw = printer.meta.layer_speeds ?? {}
  const table: Record<number, Record<string, string>> = {}
  for (const [k, v] of Object.entries(raw)) table[Math.round(parseFloat(k) * 1000) / 1000] = v
  const keys = Object.keys(table).map(Number).sort((a, b) => a - b)
  if (!keys.length) return [{}, null]
  const lhR = Math.round(lh * 1000) / 1000
  if (lhR in table) return [{ ...table[lhR] }, null]
  if (lhR < keys[0] || lhR > keys[keys.length - 1]) {
    const k = lhR < keys[0] ? keys[0] : keys[keys.length - 1]
    return [{ ...table[k] }, `Altura de camada ${lhR} mm sem preset ${printer.label}: velocidades de preenchimento do preset ${k.toFixed(2)} mm (confira a aba Velocidade).`]
  }
  const lo = Math.max(...keys.filter(k => k < lhR))
  const hi = Math.min(...keys.filter(k => k > lhR))
  const t = (lhR - lo) / (hi - lo)
  const out: Record<string, string> = {}
  for (const n of SPEED_KEYS) {
    const a = num(table[lo][n]), b = num(table[hi][n])
    if (a !== null && b !== null) out[n] = String(Math.round(a + (b - a) * t))
  }
  return [out, `Altura de camada ${lhR} mm entre os presets ${lo.toFixed(2)} e ${hi.toFixed(2)} mm: velocidades de preenchimento interpoladas.`]
}

function buildDiffLists(mp: Mapping, copied: Set<string>, nfil: number, flagSkipFlush: boolean): string[] {
  let proc = [...copied].filter(k => mp.printOpts.has(k) || mp.extraProcess.has(k) || k === 'best_object_pos').sort()
  proc = proc.filter(k => k !== 'support_object_skip_flush' || flagSkipFlush)
  const fil = [...copied].filter(k => mp.filamentOpts.has(k)).sort()
  return [proc.join(';'), ...Array(nfil).fill(fil.join(';')), '']
}

function pruneFilaments(mp: Mapping, R: ProjectSettings, nfil: number, keep: number[]): void {
  const n = keep.length
  for (const [k, v] of Object.entries(R)) {
    if (Array.isArray(v) && v.length === nfil && (mp.filamentOpts.has(k) || mp.perFilamentExtra.has(k) || mp.bedRe.test(k))) {
      R[k] = keep.map(i => v[i - 1])
    }
  }
  R.filament_self_index = Array.from({ length: n }, (_, i) => String(i + 1))
  R.filament_map = Array(n).fill('1')
  const mx = R.flush_volumes_matrix, vec = R.flush_volumes_vector
  if (Array.isArray(mx) && mx.length === nfil * nfil) {
    const out: unknown[] = []
    for (const a of keep) for (const b of keep) out.push(mx[(a - 1) * nfil + (b - 1)])
    R.flush_volumes_matrix = out
  }
  if (Array.isArray(vec) && vec.length === 2 * nfil) {
    const out: unknown[] = []
    for (const i of keep) for (const j of [0, 1]) out.push(vec[2 * (i - 1) + j])
    R.flush_volumes_vector = out
  }
  const d = R.different_settings_to_system
  if (Array.isArray(d) && d.length >= 3) {
    R.different_settings_to_system = [d[0], ...Array(n).fill(d[1]), d[d.length - 1]]
  }
}

function temperatureCompatWarnings(R: ProjectSettings, rep: ConversionReport): void {
  const toArr = (k: string) => (Array.isArray(R[k]) ? (R[k] as unknown[]).map(num) : [])
  const t = toArr('nozzle_temperature'), lo = toArr('nozzle_temperature_range_low'), hi = toArr('nozzle_temperature_range_high')
  const n = t.length
  if (lo.length !== n || hi.length !== n) return
  for (const arr of [t, lo, hi]) for (const v of arr) if (v === null) return
  const own: number[] = []
  for (let i = 0; i < n; i++) if (!(lo[i]! <= t[i]! && t[i]! <= hi[i]!)) own.push(i + 1)
  if (own.length) rep.warnings.push('Temperatura de bico fora da faixa recomendada do preset Flashforge no(s) filamento(s) ' + own.join(', ') + ': confira o material/temperatura.')
  if (n > 1) {
    const bad: Array<[number, number]> = []
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (i === j) continue
      if (!(lo[j]! <= t[i]! && t[i]! <= hi[j]!)) bad.push([i + 1, j + 1])
    }
    if (bad.length) {
      rep.warnings.push('Materiais com faixas de temperatura incompatíveis (' + bad.slice(0, 6).map(([i, j]) => `F${i}↔F${j}`).join(', ') + '): o Orca/Flash Studio só fatia com a opção de impressão com temperaturas mistas habilitada.')
    }
  }
}

function remapFeatureFilaments(mp: Mapping, R: ProjectSettings, keepIdx: number[] | null, nfilOut: number, rep: ConversionReport): void {
  const map: Map<number, number> | null = keepIdx ? new Map(keepIdx.map((o, i) => [o, i + 1])) : null
  const fixed: string[] = []
  for (const k of mp.perFeatureFilamentKeys) {
    if (!(k in R)) continue
    const v = R[k]
    const n0 = num(first(v as unknown))
    let n = n0 !== null ? Math.trunc(n0) : 0
    if (map !== null && n > 0) n = map.get(n) ?? 1
    if (n > nfilOut) n = 1
    if (FEATURE_MIN1_KEYS.has(k) && n < 1) { fixed.push(k); n = 1 }
    R[k] = Array.isArray(v) ? [String(n)] : String(n)
  }
  if (fixed.length) rep.notes.push('Filamento por recurso sem valor (0/ausente) -> 1 (o Flash Studio exige 1..N): ' + fixed.join(', ') + '.')
}

export type ConvertOptions = {
  printer_id?: string
  keep_speeds?: boolean
  prune_unused?: boolean
  src_name?: string
  single_filament?: boolean
}

export async function convertFile(src: Uint8Array | ArrayBuffer, printer: Printer, options: ConvertOptions = {}): Promise<{ output: Uint8Array; report: ConversionReport }> {
  const srcBytes = src instanceof ArrayBuffer ? new Uint8Array(src) : src
  const { keep_speeds = false, prune_unused = true, single_filament = false } = options
  const rep = newReport(printer, options.src_name ?? '')
  const info = await detect(srcBytes)
  rep.input = {
    ...rep.input,
    kind: info.kind, app: info.app, printer_model: info.printer_model,
    printer_settings_id: info.printer_settings_id, has_gcode: info.has_gcode, filaments: info.filaments,
  }
  if (info.kind !== 'bambu_project') {
    const msg = info.message || 'Entrada não suportada.'
    rep.errors.push(msg)
    throw new ConversionError(msg, rep, info.reason ?? ('unsupported_input:' + info.kind))
  }
  const { output, ctx } = await convertCore(srcBytes, printer, rep, keep_speeds, prune_unused, single_filament)
  const val = await validateOutput(srcBytes, output, printer, ctx)
  rep.validation = val as ConversionReport['validation']
  for (const w of val.warnings) rep.warnings.push(w)
  if (!val.ok) {
    rep.errors.push(...val.checks.filter(c => !c.ok && c.severity === 'error').map(c => c.detail))
    throw new ConversionError('Validação falhou; nada foi gravado.', rep, 'validation_failed')
  }
  for (const c of val.checks) {
    if (!c.ok && c.severity === 'pending'
      && !['filamentos_cabem_nos_slots', 'gcode_custom_xy_na_mesa'].includes(c.name)
      && !rep.pending.includes(c.detail)) {
      rep.pending.push(c.detail)
    }
  }
  rep.ok = true
  rep.status = rep.pending.length ? 'pendencias' : 'ok'
  rep.output = { file: '', bytes: output.byteLength }
  rep.summary = summary(rep)
  return { output, report: rep }
}

export function summary(rep: ConversionReport): Record<string, number | string> {
  return {
    status: rep.status, pendencias: rep.pending.length, mantidas: rep.kept.length,
    renomeadas: rep.renamed.length, substituidas: rep.replaced.length, descartadas: rep.discarded.length,
    sem_equivalente: rep.not_in_target.length, temperaturas_limitadas: rep.capped.length,
    avisos: rep.warnings.length, filamentos: rep.filaments.length, placas: rep.plates.length,
  }
}

async function convertCore(srcBytes: Uint8Array, printer: Printer, rep: ConversionReport, keepSpeeds: boolean, pruneUnused: boolean, singleFilament: boolean): Promise<{ output: Uint8Array; ctx: ValidationContext }> {
  const mp = loadMapping()
  const T = printer.template
  const lim = printer.limits
  const zin = await JSZip.loadAsync(srcBytes)
  const S: ProjectSettings = JSON.parse(await zin.file(SETTINGS)!.async('string'))
  const R: ProjectSettings = structuredClone(T)
  const colour0 = Array.isArray(S.filament_colour) ? (S.filament_colour as unknown[]) : ['#FFFFFF']
  const nfil = colour0.length || 1
  const si: unknown[] = Array.isArray(S.filament_self_index) ? (S.filament_self_index as unknown[]) : Array.from({ length: nfil }, (_, i) => String(i + 1))
  const fv: unknown[] = Array.isArray(S.filament_extruder_variant) ? (S.filament_extruder_variant as unknown[]) : Array(si.length).fill('Direct Drive Standard')

  // 1) vetores por filamento do template -> nº de filamentos do projeto
  for (const [k, v] of Object.entries(R)) {
    if (Array.isArray(v) && v.length === 1 && (mp.filamentOpts.has(k) || mp.perFilamentExtra.has(k))) {
      R[k] = resize(v, nfil)
    }
  }
  R.filament_self_index = Array.from({ length: nfil }, (_, i) => String(i + 1))
  R.filament_extruder_variant = Array(nfil).fill('Direct Drive Standard')
  R.filament_map = Array(nfil).fill('1')

  // 2) cores e matriz de purga NxN
  R.filament_colour = filVector(colour0, nfil, si, fv)
  sanitizeColors(R, rep)
  R.filament_multi_colour = Array(nfil).fill(MULTI_COLOUR_DEFAULT)
  rep.kept.push('filament_colour')
  if ('filament_multi_colour' in S) rep.replaced.push('filament_multi_colour')
  if ('filament_colour_type' in S) {
    R.filament_colour_type = Array(nfil).fill('1')
    rep.replaced.push('filament_colour_type')
  }
  for (const [key, per, pad] of [['flush_volumes_matrix', nfil * nfil, '0'], ['flush_volumes_vector', 2 * nfil, '140']] as const) {
    const sv = S[key]
    if (Array.isArray(sv) && sv.length >= per) {
      R[key] = sv.slice(0, per)
      rep.kept.push(key)
    } else {
      const arr = Array.isArray(sv) ? sv.slice() : []
      while (arr.length < per) arr.push(pad)
      R[key] = arr.slice(0, per)
      if (nfil > 1) rep.warnings.push(`${key}: origem curta para ${nfil} filamentos; completada com ${pad}.`)
    }
  }
  for (let i = 0; i < nfil; i++) (R.flush_volumes_matrix as unknown[])[i * nfil + i] = '0'

  // 3) nomes de preset — escolhe o preset de altura <= layer_height do autor
  //    (tie-break: mais próximo). Se o autor pediu altura abaixo do menor
  //    preset disponível, usa o menor. Reproduz o comportamento observado no
  //    ForgeBridge (ex.: layer_height=0.13 -> preset "0.12mm" em @FF C5),
  //    em vez de fixar o template em um `pin_base_layer_height`.
  const lh = num(first(S.layer_height ?? '0.2')) ?? 0.2
  const presets = printer.meta.process_presets
  const presetKeys = Object.keys(presets).sort((a, b) => parseFloat(a) - parseFloat(b))
  let chosen = presetKeys[0]
  for (const k of presetKeys) {
    if (parseFloat(k) <= lh + 1e-9) chosen = k
  }
  R.print_settings_id = presets[chosen]
  if (parseFloat(chosen) !== lh) {
    rep.notes.push(`print_settings_id: preset ${presets[chosen]} escolhido para layer_height=${lh} mm do autor (o valor do autor fica como override).`)
  }
  if (!keepSpeeds) {
    const [sp, note] = speedsForLayer(printer, lh)
    Object.assign(R, sp)
    if (note) rep.notes.push(note)
  }
  const typesRaw = Array.isArray(S.filament_type) ? (S.filament_type as unknown[]) : Array(nfil).fill('PLA')
  const types = filVector(typesRaw, nfil, si, fv).map(t => String(t))
  const fp = printer.meta.filament_presets
  const fpGeneric = printer.meta.filament_presets_generic
  const genericId = printer.meta.filament_generic_id
  const fallbackType = printer.meta.filament_fallback_type ?? 'PLA'
  const fallback = fp[fallbackType]
  // Vendor por slot (do autor). Serve para decidir quando mapear para o
  // preset Generic do destino em vez do preset de vendor Flashforge.
  const vendorsRaw = Array.isArray(S.filament_vendor) ? (S.filament_vendor as unknown[]) : []
  const vendorsSrc = vendorsRaw.length
    ? filVector(vendorsRaw, nfil, si, fv).map(v => String(v ?? ''))
    : Array(nfil).fill('')
  const names: string[] = []
  const vendors: string[] = []
  const chosenIsGeneric: boolean[] = []
  for (let i = 0; i < types.length; i++) {
    const t = types[i]
    const tu = t.toUpperCase()
    const vendor = vendorsSrc[i]
    const isGeneric = fpGeneric && vendor.trim().toLowerCase() === 'generic' && tu in fpGeneric
    if (isGeneric) {
      names.push(fpGeneric![tu])
      vendors.push('Generic')
      chosenIsGeneric.push(true)
      continue
    }
    if (!(tu in fp)) rep.warnings.push(`Filamento '${tu}' sem preset ${printer.label}: usado '${fallback}' (confira temperatura e escolha o filamento certo no fatiador).`)
    names.push(fp[tu] ?? fallback)
    // Se existe vendor de origem (não vazio) e não é Generic, mantém a
    // string original (ex.: "Bambu", "Polymaker") só como rótulo informativo;
    // valores de filamento vêm do template Flashforge. Sem autor -> usa o
    // template.
    vendors.push(vendor && vendor.trim().toLowerCase() !== 'generic' ? vendor : '')
    chosenIsGeneric.push(false)
  }
  R.filament_settings_id = names
  R.filament_type = types
  const fvals = printer.filamentValues
  for (let i = 0; i < types.length; i++) {
    const vals = fvals[types[i].toUpperCase()] ?? fvals[fallbackType] ?? {}
    for (const [k, v] of Object.entries(vals)) {
      if (['filament_type', 'filament_settings_id', 'filament_colour'].includes(k)) continue
      const slot = R[k]
      if (Array.isArray(slot) && slot.length === nfil) slot[i] = v
    }
  }
  // Se algum slot escolheu o preset Generic, grava vendor/id coerentes.
  // Mantém slots não-Generic no vendor do template (Flashforge).
  if (chosenIsGeneric.some(Boolean)) {
    const rv = Array.isArray(R.filament_vendor) ? (R.filament_vendor as unknown[]).slice() : Array(nfil).fill('Flashforge')
    while (rv.length < nfil) rv.push(rv.length ? rv[rv.length - 1] : 'Flashforge')
    const rid = Array.isArray(R.filament_ids) ? (R.filament_ids as unknown[]).slice() : Array(nfil).fill('')
    while (rid.length < nfil) rid.push(rid.length ? rid[rid.length - 1] : '')
    for (let i = 0; i < nfil; i++) {
      if (chosenIsGeneric[i]) {
        rv[i] = 'Generic'
        if (genericId) rid[i] = genericId
      } else if (vendors[i]) {
        rv[i] = vendors[i]
      }
    }
    R.filament_vendor = rv
    R.filament_ids = rid
    rep.notes.push(`filament_vendor "Generic" do autor preservado em ${chosenIsGeneric.filter(Boolean).length} slot(s); preset ${chosenIsGeneric.map((g, i) => g ? names[i] : null).filter(Boolean).join(', ')} em vez do vendor Flashforge.`)
  }
  // Guarda de tempo de execução para o diâmetro físico. Independente do
  // template ou da escolha do preset, as impressoras Flashforge do Extruvo
  // são todas 1,75 mm. Força o valor sempre que o meta da impressora
  // declarar `filament_diameter_mm`. Corrige regressão histórica (Creator
  // 5 / 5 Pro gravavam 2,85 mm em 0.3.3). Documentado em NOTICE.
  if (typeof printer.meta.filament_diameter_mm === 'number' && Number.isFinite(printer.meta.filament_diameter_mm)) {
    const diam = String(printer.meta.filament_diameter_mm)
    const before = R.filament_diameter
    const target = Array(nfil).fill(diam)
    const changed = !Array.isArray(before) || before.length !== nfil
      || (before as unknown[]).some((v, i) => String(v) !== target[i])
    R.filament_diameter = target
    if (changed) rep.notes.push(`filament_diameter: forçado para ${diam} mm (fonte: ${printer.label}.filament_diameter_mm).`)
  }

  // 4) copia as configurações do autor
  const copied = new Set<string>()
  const slowKeep = slowerAuthorSpeeds(mp, S, T)
  if (Object.keys(slowKeep).length && !keepSpeeds) {
    rep.notes.push('O autor deixou algumas velocidades MAIS LENTAS que as da impressora; foram mantidas: '
      + Object.entries(slowKeep).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k} ${fmt(v)} mm/s`).join(', ') + '.')
  }
  for (const [key, sv] of Object.entries(S)) {
    const [cat, tk] = mp.classify(key, T, keepSpeeds, slowKeep)
    if (cat === 'handled') continue
    if (cat === 'no_target') { rep.not_in_target.push(key); continue }
    if (cat === 'replaced') { rep.replaced.push(key); continue }
    if (cat === 'ids' || cat === 'machine' || cat === 'motion') {
      rep.discarded.push({ key, reason: { ids: 'identificador/variante de preset', machine: 'pertence à máquina', motion: 'velocidade/aceleração da máquina de origem' }[cat] as string })
      continue
    }
    if (key === 'filament_type') { rep.kept.push(key); copied.add(key); continue }
    let val = adaptValue(mp, tk, sv, T[tk], nfil, si, fv)
    const motion = mp.isMotion(tk)
    if (motion && !Array.isArray(val) && num(val) === 0 && (tk.includes('accel') || tk.includes('jerk'))) {
      if (num(T[tk]) !== 0) rep.notes.push(`${tk}: 0 no Bambu significa 'padrão' -> mantido ${T[tk]} do destino.`)
      continue
    }

    const cap = (x: unknown, hi: number, what: string) => {
      const n = num(x)
      if (n === null || String(x).endsWith('%') || n <= hi) return x
      rep.capped.push({ key: tk, from: String(x), to: String(hi), limit: what })
      return String(Number.isInteger(hi) ? Math.trunc(hi) : hi)
    }
    if (mp.tempKeys.includes(tk) && Array.isArray(val)) {
      val = val.map(x => cap(x, lim.nozzle_max_c as number, 'bico'))
    } else if (mp.bedRe.test(tk) && Array.isArray(val)) {
      val = val.map(x => cap(x, lim.bed_max_c as number, 'mesa'))
    } else if (motion && keepSpeeds && !Array.isArray(val)) {
      val = cap(val, (tk.includes('accel') ? lim.max_accel_mm_s2 : lim.max_speed_mm_s) as number, 'movimento')
    }
    if (tk in mp.ranges) {
      const [lo, hi] = mp.ranges[tk]
      const sane = (x: unknown) => {
        const n = num(x)
        if (n === null) return x
        if ((lo === null || n >= lo) && (hi === null || n <= hi)) return x
        const clamped = Math.min(Math.max(n, lo ?? n), hi ?? n)
        const neu = mp.fixDefault[tk] ?? fmt(clamped)
        if (n === -1) rep.notes.push(`${tk}: -1 ('auto' no Bambu) não é aceito pelo Orca -> ${neu}.`)
        else rep.warnings.push(`${tk}: ${x} fora da faixa do Orca (${lo}..${hi}) -> ${neu}.`)
        return neu
      }
      val = Array.isArray(val) ? val.map(sane) : sane(val)
    }
    const rw = mp.valueRewrites[tk]
    if (rw && !Array.isArray(val) && String(val as string) in rw) {
      // support_style: tree_organic → default é a única reescrita hoje; é
      // segura para AD5X / Adventurer 5M / 5M Pro (sem evidência de
      // tree_organic no Flash Studio para esses alvos), mas Flashforge
      // Creator 5 / 5 Pro aceitam a chave no Flash Studio 1.7.21 — a
      // reescrita apagaria a intenção do autor sem benefício. Pular quando
      // o destino declarar `support_tree_organic_accepted`.
      const skip = tk === 'support_style'
        && String(val as string) === 'tree_organic'
        && printer.meta.support_tree_organic_accepted === true
      if (!skip) {
        rep.notes.push(`${tk}: '${val}' do Bambu -> '${rw[String(val as string)]}' no Orca.`)
        val = rw[String(val as string)]
      } else {
        rep.notes.push(`${tk}: '${val}' preservado (${printer.label} aceita tree_organic no fatiador alvo).`)
      }
    }
    R[tk] = val
    copied.add(tk)
    if (tk !== key) rep.renamed.push({ from: key, to: tk })
    else rep.kept.push(key)
  }

  sanitizeColors(R, rep)
  const srcNoz = S.nozzle_diameter
  if (Array.isArray(srcNoz) && srcNoz.length > 1) {
    rep.warnings.push(`O projeto de origem é de impressora com ${srcNoz.length} bicos (${S.printer_model ?? '?'}): a ${printer.label} tem 1 bico. Filamentos/placas foram convertidos, mas confira atribuição de cores, torre de purga e tempos no fatiador.`)
  }

  const srcBed = String(S.curr_bed_type ?? '')
  const dstBed = printer.meta.bed_type ?? 'Textured PEI Plate'
  R.curr_bed_type = dstBed
  if (srcBed && srcBed !== dstBed) {
    const tkBed = BED_KEY_BY_TYPE[dstBed]
    rep.notes.push(`Mesa de origem '${srcBed}' -> '${dstBed}': vale a temperatura do autor para ${dstBed} (${tkBed} = ${first((R[tkBed] as unknown) ?? ['?'])} °C), não a da mesa de origem.`)
  }

  if (!keepSpeeds) {
    for (const key of Object.keys(S)) {
      const tk = mp.targetKey(key)
      if (tk in R && mp.isMotion(tk)) {
        const a = first(S[key] as unknown), b = first(R[tk] as unknown)
        rep.speeds.push({
          key: tk, from: String(a), to: String(b),
          status: tk in slowKeep ? 'mantida (autor mais lento)' : (String(a) === String(b) ? 'igual' : 'do perfil da impressora'),
        })
      }
    }
  }

  // 5) different_settings_to_system
  // Marca as velocidades do preset do destino como "customizadas" em
  // relação ao sistema sempre que o motor reescreve essas chaves via
  // speedsForLayer (ou seja, quando !keepSpeeds). Isso impede o Flash
  // Studio / Orca de reverter para os valores default do preset ao abrir
  // o 3MF, já que o nome do preset escolhido pode não ser idêntico ao
  // original do autor.
  if (!keepSpeeds) for (const k of SPEED_KEYS) if (k in R) copied.add(k)
  // `support_object_skip_flush` é uma opção do Bambu Studio (não purgar ao imprimir suporte).
  // No Flash Studio, ligada junto com `exclude_object` (padrão dos perfis Flashforge), o
  // fatiamento aborta com "Unknown label object id!" (isolado por busca binária em
  // 2026-11-20: diplodok, sagrada_familia, T-Rex...). Volta ao valor do perfil de destino.
  // Nas Adventurer 5M / 5M Pro (rótulo de objetos pelo firmware) o erro é o mesmo, então a
  // regra vale para todos os destinos.
  if (String(first(R.support_object_skip_flush as unknown) ?? '0') === '1' && String(first(T.support_object_skip_flush as unknown) ?? '0') !== '1') {
    R.support_object_skip_flush = T.support_object_skip_flush ?? '0'
    rep.notes.push("support_object_skip_flush: '1' do Bambu faz o fatiador da " + printer.label + ' abortar ("Unknown label object id!"); mantido o valor do perfil de destino.')
  }
  const skipFlushDiff = copied.has('support_object_skip_flush')
    && String(first(R.support_object_skip_flush ?? '0')) !== String(first(T.support_object_skip_flush ?? '0'))
  R.different_settings_to_system = buildDiffLists(mp, copied, nfil, skipFlushDiff)
  const sd = S.different_settings_to_system
  if (Array.isArray(sd)) {
    const slots = sd.length > 1 ? sd.slice(0, -1) : sd
    for (const slot of slots) {
      for (const k of String(slot).split(';')) {
        if (!k) continue
        const ent: AuthorCustomised = { key: k, carried: copied.has(mp.targetKey(k)) }
        if (!rep.author_customised.some(e => e.key === ent.key && e.carried === ent.carried)) rep.author_customised.push(ent)
      }
    }
  }
  const notCarried = rep.author_customised.filter(e => !e.carried).map(e => e.key)
  if (notCarried.length) {
    rep.notes.push('Customizações do autor NÃO levadas (máquina/velocidade/calibração de filamento): ' + notCarried.slice(0, 25).join(', ') + (notCarried.length > 25 ? ' ...' : ''))
  }

  temperatureCompatWarnings(R, rep)
  if (rep.capped.length) {
    rep.warnings.push('Temperaturas acima do limite da ' + printer.label + ' foram limitadas: ' + rep.capped.slice(0, 8).map(c => `${c.key} ${c.from}→${c.to} °C`).join(', ') + '. Confira se o material é adequado à máquina.')
  }

  // Compat: filament_extruder_variant e filament_map têm length = nfil;
  // nozzle_volume_type tem length = min(nfil, toolheads) (bate por
  // posição de toolhead com default_nozzle_volume_type). Confirmado
  // contra o 3MF single_color oficial exportado pelo Flash Studio 1.7.9 em
  // 2026-11-14 (Creator 5 / 5 Pro single_color: 4 toolheads + 1 filamento
  // → length 1, evita SIGSEGV) e contra o perfil upstream Creality
  // Ender-3 0.2 (1 toolhead + 4 filamentos → length 1, evita o Orca 2.5
  // recusar a torre com exit 156 "partially outside the printable area").
  // OrcaSlicer 2.5 também recusa retraction_distances_when_cut fora de
  // [10, 18] e reverte para o valor herdado se a chave não constar do
  // slot de máquina de different_settings_to_system.
  alignFilamentKeysToNfil(R, nfil, rep)
  clampRetractionDistancesWhenCut(R, rep)
  markRetractionDistancesInMachineSlot(R, printer)

  // 6) placas, filamentos usados, reposicionamento
  let ob: Area | null = null
  let ow = 0, oh = 0
  try {
    const area = S.printable_area as unknown as string[]
    ob = parseArea(area)
    ow = ob[2] - ob[0]; oh = ob[3] - ob[1]
  } catch { ob = null }
  const nb = parseArea(R.printable_area as string[])
  const nw = nb[2] - nb[0], nh = nb[3] - nb[1]
  const maxH = num(first(R.printable_height as unknown)) ?? 0

  const namesIn = Object.keys(zin.files)
  let keepIdx: number[] | null = null
  let fixes = new Map<string, number>(), rebase = new Map<string, number>()
  let filInfo: M.FilamentAnalysis | null = null
  if (nfil > 1) {
    filInfo = await M.analyzeFilaments(zin, S, nfil, mp.perFeatureFilamentKeys)
    if (pruneUnused) {
      if (filInfo.used === null) {
        rep.notes.push(`Não foi possível saber quais dos ${nfil} filamentos o modelo usa (${filInfo.why}); todos foram mantidos.`)
      } else {
        fixes = filInfo.fixes; rebase = filInfo.rebase
        rep.notes.push(...filInfo.notes)
        if (filInfo.used.size < nfil) {
          keepIdx = [...filInfo.used].sort((a, b) => a - b)
          pruneFilaments(mp, R, nfil, keepIdx)
          rep.notes.push(`Filamentos: o arquivo definia ${nfil} e o modelo usa ${keepIdx.length}; ${nfil - keepIdx.length} não usado(s) removido(s) (originais: ${keepIdx.join(', ')}).`)
        }
      }
    }
  }
  let merged = false
  if (singleFilament && nfil > 1) {
    const used = filInfo?.used ? [...filInfo.used].sort((a, b) => a - b) : [1]
    const primary = used[0]
    if (keepIdx === null) pruneFilaments(mp, R, nfil, [primary])
    else {
      const cur = keepIdx.length
      pruneFilaments(mp, R, cur, [1])
    }
    keepIdx = [primary]
    fixes = new Map(); rebase = new Map()
    merged = true
    rep.notes.push(`Fundido em 1 filamento (opção 'um filamento só'): ficou o filamento original ${primary}; pintura de cor removida e trocas de ferramenta por camada descartadas. Malha, suportes e costuras pintados foram mantidos.`)
  }
  const nfilOut = keepIdx ? keepIdx.length : nfil
  remapFeatureFilaments(mp, R, keepIdx, nfilOut, rep)
  if (keepIdx && nfilOut === 1) R.enable_prime_tower = '0'
  // Se pruneFilaments reduziu o nº de filamentos, realinha as três chaves
  // indexadas por filamento (nozzle_volume_type não entra em filamentOpts/
  // perFilamentExtra e precisa ser aparado explicitamente).
  if (nfilOut !== nfil) alignFilamentKeysToNfil(R, nfilOut, rep)
  if (nfilOut > printer.slots) {
    let msg: string
    if (printer.slots === 1) {
      msg = `${nfilOut} filamentos, mas a ${printer.label} tem 1 carretel: o G-code terá trocas de ferramenta (${nfilOut === 2 ? 'T1' : `T1..T${nfilOut - 1}`}) SEM pausa para troca manual. Use a opção 'um filamento só' ou reatribua as cores antes de imprimir.`
    } else {
      msg = `${nfilOut} filamentos, mas a ${printer.label} tem ${printer.slots} slots (${printer.meta.slot_system}): o G-code usaria ${nfilOut - 1 === printer.slots ? `T${printer.slots}` : `T${printer.slots}..T${nfilOut - 1}`}, que não existem. Junte/reatribua cores (até 4) no fatiador antes de imprimir.`
    }
    rep.warnings.push(msg); rep.pending.push(msg)
  }
  let layerChanges = filInfo?.layer_changes ?? []
  if (!layerChanges.length && namesIn.includes(M.CUSTOM_GCODE)) {
    layerChanges = M.parseCustomGcode(await zin.file(M.CUSTOM_GCODE)!.async('string')) ?? []
  }
  if (layerChanges.length) {
    const kinds: Record<string, string> = { 0: 'troca de cor (M600)', 1: 'pausa', 2: 'troca de filamento', 3: 'template', 4: 'G-code custom' }
    rep.notes.push('Trocas/pausas por camada preservadas: ' + layerChanges.slice(0, 12).map(e => {
      const tLabel = kinds[e.type ?? ''] ?? e.type
      const ex = (e.extruder && e.extruder !== '0') ? ` F${e.extruder}` : ''
      return `z=${e.top_z} ${tLabel}${ex}`
    }).join(', ') + (layerChanges.length > 12 ? ' ...' : ''))
    if (layerChanges.some(e => e.type === '0')) {
      rep.warnings.push(`Há troca de cor por camada (M600). Confirme no Flash Studio/firmware se a ${printer.label} pausa para troca manual nesse ponto.`)
    }
  }

  const origIdx = keepIdx ?? Array.from({ length: nfil }, (_, i) => i + 1)
  for (let i = 0; i < origIdx.length; i++) {
    rep.filaments.push({
      slot: i + 1, original: origIdx[i],
      color: first(((R.filament_colour as unknown[])[i] as unknown) ?? ''),
      type: (R.filament_type as unknown[])[i] as string ?? '',
      preset: (R.filament_settings_id as unknown[])[i] as string ?? '',
      nozzle_temp: first((Array.isArray(R.nozzle_temperature) ? (R.nozzle_temperature as unknown[])[i] : '')),
    })
  }

  const modelSettings = await zin.file(M.MODEL_SETTINGS)?.async('string')
  const plates = M.parsePlates(modelSettings ?? '')
  function rejectAmbiguousPlates(): never {
    const msg = 'Não foi possível identificar as placas deste 3MF. Salve cada placa em um 3MF separado no fatiador e converta os arquivos individualmente.'
    rep.errors.push(msg)
    throw new ConversionError(msg, rep, 'ambiguous_plates')
  }
  if (!plates) rejectAmbiguousPlates()
  const pids = plates.size ? [...plates.keys()].sort((a, b) => a - b) : [1]
  const multi = pids.length > 1
  // Projeto de placa única sem `printable_area` (3MF montado por script/outro programa): sem
  // saber a mesa de origem o motor não reposicionava nada e a peça ficava onde estava — na
  // origem, fora da área útil de algumas impressoras ("Nothing to be sliced"). Assume-se a
  // mesa de destino como referência; a placa é centralizada pela caixa real das peças.
  if ((!ob || !(ow > 0) || !(oh > 0)) && !multi) {
    ob = [nb[0], nb[1], nb[2], nb[3]]
    ow = nw; oh = nh
    rep.notes.push(`O projeto de origem não declara a área de impressão; as peças foram centralizadas na mesa da ${printer.label}.`)
  }
  const items = await M.itemBboxes(zin)
  // instance_id é a posição entre as ocorrências do mesmo objectid no <build>.
  const itemsByObject = new Map<string, number[]>()
  for (const { objectId, index } of items) {
    const siblings = itemsByObject.get(objectId)
    if (siblings) siblings.push(index)
    else itemsByObject.set(objectId, [index])
  }
  const itemPlate = new Map<number, number>()
  for (const [pid, instances] of plates) {
    for (const { objectId, instanceIndex } of instances) {
      const siblings = itemsByObject.get(objectId)
      if (!siblings) continue
      // Arquivos antigos podem informar apenas o objeto.
      const indices = instanceIndex === null ? siblings : [siblings[instanceIndex]]
      for (const index of indices) {
        const previous = itemPlate.get(index)
        if (index === undefined || (previous !== undefined && previous !== pid)) rejectAmbiguousPlates()
        itemPlate.set(index, pid)
      }
    }
  }
  const oldOrg = ow ? new Map(pids.map((pid, i) => [pid, plateOrigin(i, pids.length, ow, oh)] as const)) : new Map<number, [number, number]>()
  const newOrg = new Map(pids.map((pid, i) => [pid, plateOrigin(i, pids.length, nw, nh)] as const))

  function guessPlate(x: number, y: number): number | null {
    if (oldOrg.size === 0) return pids.length === 1 ? pids[0] : null
    const cols = Math.max(1, Math.ceil(Math.sqrt(pids.length) - 1e-9))
    const col = Math.max(0, Math.floor(x / (ow * 1.2)))
    const row = y < 0 ? Math.ceil(-y / (oh * 1.2)) : 0
    const idx = row * cols + col
    return (idx >= 0 && idx < pids.length) ? pids[idx] : null
  }
  for (const { index, bbox } of items) {
    if (bbox && !itemPlate.has(index)) {
      const p = guessPlate((bbox[0] + bbox[3]) / 2, (bbox[1] + bbox[4]) / 2)
      if (p !== null) itemPlate.set(index, p)
    }
  }

  // bbox por placa
  const boxes = new Map<number, { fit: [number, number, number, number] | null; mod: [number, number, number, number] | null; height: number | null }>()
  for (const pid of pids) {
    let fit: [number, number, number, number] | null = null
    let mod: [number, number, number, number] | null = null
    const pj = `Metadata/plate_${pid}.json`
    if (namesIn.includes(pj)) {
      try {
        const j = JSON.parse(await zin.file(pj)!.async('string')) as { bbox_all?: number[]; bbox_objects?: Array<{ bbox?: number[] }> }
        if (Array.isArray(j.bbox_all) && j.bbox_all.length === 4) fit = j.bbox_all as [number, number, number, number]
        const bo = (j.bbox_objects ?? []).map(o => o.bbox).filter((b): b is number[] => !!b && b.length === 4)
        if (bo.length) mod = [Math.min(...bo.map(b => b[0])), Math.min(...bo.map(b => b[1])), Math.max(...bo.map(b => b[2])), Math.max(...bo.map(b => b[3]))]
      } catch { /* ignore */ }
    }
    const ub = M.unionBbox(items.filter(item => itemPlate.get(item.index) === pid).map(item => item.bbox))
    // A caixa medida nas peças (exata) vale mais que a do cache de fatiamento do autor
    // (`plate_N.json`), que fica desatualizada quando ele move/gira algo depois de fatiar e
    // ainda inclui a torre de purga antiga. Centralizar por ela jogava a peça para fora da
    // mesa (BS+decoupe: Y de -4,5 a 204,9 numa mesa de 220). A torre é posicionada à parte.
    if (ub && ob && oldOrg.size) {
      const [ox, oy] = oldOrg.get(pid)!
      mod = [ub[0] - ox - ob[0], ub[1] - oy - ob[1], ub[3] - ox - ob[0], ub[4] - oy - ob[1]]
      fit = mod
    }
    if (!fit) fit = mod
    const height = ub ? ub[5] - Math.min(ub[2], 0) : null
    boxes.set(pid, { fit, mod, height })
  }

  const shifts = new Map<number, [number, number]>()
  for (const pid of pids) {
    const { fit } = boxes.get(pid)!
    if (fit) shifts.set(pid, [nw / 2 - (fit[0] + fit[2]) / 2, nh / 2 - (fit[1] + fit[3]) / 2])
    else if (ow) shifts.set(pid, [(nw - ow) / 2, (nh - oh) / 2])
    else shifts.set(pid, [0, 0])
  }
  if (multi) rep.notes.push(`Projeto com ${pids.length} placas: cada placa foi recentralizada na mesa ${printer.label} e redistribuída na grade de placas do destino; cada placa mantém sua torre de purga.`)

  // suportes pintados exigem suporte ligado
  const mirror: Record<string, string> = {}
  const sd0 = Array.isArray(S.different_settings_to_system) ? (S.different_settings_to_system as unknown[]) : []
  const authorProc = new Set<string>(sd0.length ? String(sd0[0]).split(';') : [])
  if (authorProc.has('enable_support') && 'enable_support' in R) {
    mirror.enable_support = String(first(R.enable_support as unknown) ?? '')
  }
  let paintSup = false, paintedColors = false
  for (const n of namesIn) {
    if (!/\.model$/i.test(n)) continue
    if (!paintSup && await M.hasPaintSupports(zin, n)) paintSup = true
    if (!paintedColors && await M.hasPaint(zin, n)) paintedColors = true
    if (paintSup && paintedColors) break
  }
  if (paintSup && ['0', 'false'].includes(String(first(R.enable_support ?? '0')))) {
    R.enable_support = '1'
    mirror.enable_support = '1'
    const diff = R.different_settings_to_system as string[]
    const procSlot = diff[0].split(';').filter(Boolean)
    if (!procSlot.includes('enable_support')) {
      procSlot.push('enable_support')
      procSlot.sort()
      diff[0] = procSlot.join(';')
    }
    rep.notes.push('O modelo tem suportes pintados à mão e a geração de suporte estava desligada: foi ligada (enable_support) para que esses suportes existam no fatiamento.')
  }
  // Altura de camada variável + suporte em árvore orgânico: o Flash Studio/Orca recusam o
  // projeto inteiro ("Variable layer height is not supported with Organic supports"). Troca-se
  // só o ESTILO para a árvore híbrida, que aceita altura variável; a altura variável, o tipo
  // de suporte e os suportes pintados do autor ficam como estão.
  let hybridTreeRewrite = false
  if (namesIn.includes(M.LAYER_HEIGHTS_PROFILE)
    && String(first(R.support_type ?? '')).toLowerCase().startsWith('tree')
    && ORGANIC_TREE_STYLES.includes(String(first(R.support_style ?? 'default')))
    && M.hasVariableLayerHeight(await zin.file(M.LAYER_HEIGHTS_PROFILE)!.async('string'))) {
    const before = String(first(R.support_style ?? 'default'))
    R.support_style = 'tree_hybrid'
    addProcessDiff(R, 'support_style')
    hybridTreeRewrite = true
    rep.warnings.push(`O projeto usa altura de camada variável junto com suporte em árvore no estilo '${before}', que no Flash Studio/Orca é o orgânico — combinação que o fatiador recusa. O estilo do suporte foi trocado para árvore híbrida (tree_hybrid), que aceita altura variável; a altura variável e os suportes pintados do autor foram mantidos. Confira os suportes na prévia antes de imprimir.`)
  }
  warnRiskySupportCombo(R, rep, paintSup)
  warnThinWallCombo(R, rep)

  // torre de purga por placa
  //
  // Mantém a fórmula original (reserve = tw + 6 em X, tw*1.5 + 6 em Y) para
  // compatibilidade com a paridade Python v0.2.3. Três mudanças: (1) o clamp
  // é aplicado SEMPRE — inclusive quando o projeto do autor não traz
  // wipe_tower_x/y e o template da impressora destino contém coordenadas
  // fora da mesa (ex.: Creality Ender-3 0.2 traz wipe_tower_y=181 num bed
  // 0..220 com prime_tower_width=60); (2) a reserva externa inclui tudo que
  // cresce fora do perímetro da torre no Orca 2.5: prime_tower_brim_width,
  // skirt_loops×skirt_distance, wipe_tower_rib_width e a contribuição da
  // base cônica (wipe_tower_cone_angle), somados a 1 mm de folga —
  // antes a conta considerava só skirt+brim do modelo e o Orca recusava
  // multicolor_4 em Ender-3 0.2 (tw+brim+skirt caía em 221 numa mesa 220);
  // (3) se a torre + margem não couberem fisicamente na mesa, desligamos a
  // torre em vez de gravar valores inválidos — o Orca rejeita com
  // "Prime tower is partially outside the printable area".
  const tw = num(first(R.prime_tower_width as unknown)) ?? 35.0
  const th = tw * 1.5
  const skirtLoops = num(first(R.skirt_loops as unknown)) ?? 0
  const skirtDist = num(first(R.skirt_distance as unknown)) ?? 0
  // Fórmula pedida pelo follow-up: skirt_loops × skirt_distance (0 sem skirt).
  const skirtOuter = skirtLoops > 0 ? skirtLoops * Math.max(0, skirtDist) : 0
  const brimType = String(first(R.brim_type as unknown) ?? '').toLowerCase()
  const brimActive = brimType && brimType !== 'no_brim'
  const brimWidth = brimActive ? Math.max(0, num(first(R.brim_width as unknown)) ?? 0) : 0
  // Brim da própria torre de purga (sempre ativa quando a torre está ligada).
  const primeTowerBrim = Math.max(0, num(first(R.prime_tower_brim_width as unknown)) ?? 0)
  // Rib e cone da base do wipe tower type2 do Orca 2.5. Para o cone usamos
  // uma estimativa curta baseada no ângulo (sem saber a altura real da
  // impressão) e cortamos em 8 mm para não penalizar mesas grandes.
  const ribWidth = Math.max(0, num(first(R.wipe_tower_rib_width as unknown)) ?? 0)
  const coneAngle = Math.max(0, num(first(R.wipe_tower_cone_angle as unknown)) ?? 0)
  const coneExtra = coneAngle > 0 ? Math.min(8, Math.tan((coneAngle * Math.PI) / 180) * 8) : 0
  // Reserva total externa (cada lado) + 1 mm de folga mínima para que o
  // teste do Orca aceite com ≥0,5 mm de margem.
  const towerOuterPad = Math.max(primeTowerBrim, brimWidth) + skirtOuter + ribWidth + coneExtra + 1
  // Mantém a "folga de 6 mm" histórica como piso para não quebrar a paridade
  // Python em projetos sem skirt/brim/rib/cone.
  const extraPad = Math.max(0, towerOuterPad - 6)
  const needX = tw + 2 * Math.max(towerOuterPad, 6)
  const needY = th + 2 * Math.max(towerOuterPad, 6)
  const canFit = needX <= nw && needY <= nh
  const towers = new Map<number, [number | null, number | null]>()
  for (const pid of pids) towers.set(pid, [null, null])
  const primeTowerWasEnabled = String(first(R.enable_prime_tower as unknown) ?? '0') === '1'
  if (primeTowerWasEnabled && !canFit && nfilOut > 1 && !merged) {
    R.enable_prime_tower = '0'
    const diff = R.different_settings_to_system as string[] | undefined
    if (Array.isArray(diff) && diff.length) {
      const procSlot = String(diff[0]).split(';').filter(Boolean)
      if (!procSlot.includes('enable_prime_tower')) {
        procSlot.push('enable_prime_tower')
        procSlot.sort()
        diff[0] = procSlot.join(';')
      }
    }
    const msg = `Torre de purga ${tw.toFixed(0)} mm + skirt/brim não cabem na mesa ${nw.toFixed(0)}x${nh.toFixed(0)} mm da ${printer.label}: torre desligada (enable_prime_tower=0). Para imprimir multicolor nesta mesa, use a opção "Fundir em um filamento" no conversor ou reduza skirt/brim/width no Orca.`
    rep.warnings.push(msg); rep.pending.push(msg)
  }
  const dims: Array<['x' | 'y', number]> = [['x', nw], ['y', nh]]
  for (let ai = 0; ai < 2; ai++) {
    const [ax, limAx] = dims[ai]
    const k = 'wipe_tower_' + ax
    const oSrc = ob ? ob[ai] : 0.0
    const oDst = nb[ai]
    const reserve = (ai === 0 ? (tw + 6.0) : (tw * 1.5 + 6.0)) + extraPad
    const minLocal = 4.0 + extraPad
    const maxLocal = Math.max(minLocal, limAx - reserve)
    let sv = S[k]
    const haveSource = sv !== undefined && sv !== null
    if (haveSource) sv = Array.isArray(sv) ? sv : [sv]
    const tplBase = (() => {
      const tv = T[k]
      const tvArr = Array.isArray(tv) ? tv as unknown[] : (tv !== undefined && tv !== null ? [tv] : [])
      const n = num(first(tvArr as unknown[]))
      if (n === null) return null
      return n - oDst
    })()
    const vals = Array.from({ length: pids.length }, (_, i) => {
      if (haveSource) {
        const arr = sv as unknown[]
        const n = arr.length ? num(arr[Math.min(i, arr.length - 1)]) : null
        if (n !== null) return n - oSrc + shifts.get(pids[i])![ai]
      }
      return tplBase
    })
    if (vals.every(v => v !== null)) {
      R[k] = vals.map(v => fmt(oDst + Math.min(Math.max(v!, minLocal), maxLocal), 2))
    }
    const rv = R[k]
    const rvArr = Array.isArray(rv) ? rv as unknown[] : (rv !== undefined && rv !== null ? [rv] : [])
    for (let i = 0; i < pids.length; i++) {
      const pid = pids[i]
      const v = rvArr.length ? num(rvArr[Math.min(i, rvArr.length - 1)]) : null
      towers.get(pid)![ai] = v !== null ? v - oDst : null
    }
  }

  // --- caixas dos itens de cada placa, em coordenadas locais da mesa de destino ---
  const localBoxes = new Map<number, Rect[]>()
  for (const pid of pids) localBoxes.set(pid, [])
  if (ow && ob) {
    for (const item of items) {
      const pid = itemPlate.get(item.index)
      if (pid === undefined || !item.bbox || !item.printable) continue
      const [ox, oy] = oldOrg.get(pid) ?? [0, 0]
      const [dx, dy] = shifts.get(pid)!
      const b = item.bbox
      localBoxes.get(pid)!.push({
        x0: b[0] - ox - ob[0] + dx, y0: b[1] - oy - ob[1] + dy,
        x1: b[3] - ox - ob[0] + dx, y1: b[4] - oy - ob[1] + dy,
        h: b[5] - Math.min(b[2], 0),
      })
    }
  }
  const plateFilaments = (pid: number): number => {
    if (filInfo && filInfo.used) {
      const pu = new Set<number>()
      for (const { objectId } of (plates.get(pid) ?? [])) for (const v of (filInfo.obj_used.get(objectId) ?? [])) pu.add(v)
      if (pu.size) return pu.size
    }
    return nfilOut
  }
  const towerEnabled = () => String(first(R.enable_prime_tower as unknown) ?? '0') === '1'

  // --- torre de purga × modelo ---
  // O clamp acima só garante a torre dentro da mesa. Numa mesa menor que a de origem a
  // posição do autor (ou a do template) pode cair em cima de uma peça, e o fatiador aborta
  // com "gcode path conflicts found between WipeTower and <objeto>". Quando isso acontece a
  // torre vai para o ponto livre com mais espaço à frente (a profundidade real da torre
  // cresce com o volume de purga), o mais perto possível da posição original.
  const towerBlocked = new Set<number>()
  if (towerEnabled() && nfilOut > 1 && !merged) {
    // Folga torre x peça: o brim da peça + o brim da torre. Folga torre x borda da mesa: só o
    // que cresce em volta da TORRE (brim, nervura, cone) — o brim da peça não entra aqui; com
    // ele (brim de 20 mm do autor) nenhuma posição era aceita numa mesa de 220 mm.
    const keepGap = brimWidth + primeTowerBrim + skirtOuter + 2
    const wantGap = Math.max(keepGap, primeTowerBrim + ribWidth + coneExtra + 1, 6)
    const edgePad = Math.max(0, primeTowerBrim + ribWidth + coneExtra + 1 - 6)
    const minX = 4 + edgePad, maxX = Math.max(minX, nw - (tw + 6) - edgePad)
    const minY = 4 + edgePad
    const axis = (lo: number, hi: number): number[] => {
      const out: number[] = []
      for (let v = lo; v < hi - 1e-9; v += 4) out.push(v)
      out.push(hi)
      return out
    }
    // A profundidade real da torre depende do volume de purga e não é conhecida antes de
    // fatiar. Procura-se primeiro um ponto livre para a estimativa folgada (1,5 x largura);
    // se a mesa não tiver esse espaço, aceita-se a estimativa curta (torre retangular de
    // purga pequena, como a medida no Flash Studio: ~14 mm para 75 mm de largura).
    const shortDepth = Math.max(20, tw * 0.6)
    const hits = (boxes: Rect[], x: number, y: number, depth: number, gap: number) =>
      boxes.some(b => x - gap < b.x1 && x + tw + gap > b.x0 && y - gap < b.y1 && y + depth + gap > b.y0)
    const roomAhead = (boxes: Rect[], x: number, y: number, depth: number, gap: number) => {
      let lim = nh - 4 - y
      for (const b of boxes) if (x - gap < b.x1 && x + tw + gap > b.x0 && b.y0 >= y + depth) lim = Math.min(lim, b.y0 - gap - y)
      return Math.min(lim, 3 * tw)
    }
    const moved: string[] = []
    for (const pid of pids) {
      const boxes = localBoxes.get(pid)!
      const tx = towers.get(pid)![0], ty = towers.get(pid)![1]
      // Vale para toda placa, inclusive as de um filamento só: o fatiador confere a posição
      // da torre contra as peças ("Prime Tower is too close to others") mesmo sem usá-la.
      if (tx === null || ty === null || !boxes.length) continue
      if (!hits(boxes, tx, ty, th, keepGap)) continue
      let bx = 0, by = 0, found = false
      let bestScore = -Infinity
      for (const [depth, gap] of [[th, wantGap], [th, keepGap], [shortDepth, wantGap], [shortDepth, keepGap]] as const) {
        const topY = Math.max(minY, nh - (depth + 6) - edgePad)
        for (const x of axis(minX, maxX)) for (const y of axis(minY, topY)) {
          if (hits(boxes, x, y, depth, gap)) continue
          // Preferência: longe das peças (suportes em árvore e brim saem da caixa da peça),
          // com espaço à frente; a distância à posição original só desempata.
          const rect: Rect = { x0: x, y0: y, x1: x + tw, y1: y + depth, h: 0 }
          const clearance = Math.min(80, ...boxes.map(b => rectDistance(rect, b)))
          const score = clearance * 6 + roomAhead(boxes, x, y, depth, gap) * 2 - Math.hypot(x - tx, y - ty) * 0.25
          if (score > bestScore) { bestScore = score; bx = x; by = y; found = true }
        }
        if (found) break
      }
      if (!found) {
        // Sem ponto livre com a placa centralizada. Se o conjunto de peças + a torre cabem
        // lado a lado na mesa, o conjunto inteiro (bloco rígido) é encostado em uma borda e a
        // torre ocupa a faixa que sobra. Só placas que usam mais de um filamento: nas demais
        // a torre não é impressa e não vale a pena tirar a peça do centro.
        if (plateFilaments(pid) > 1) {
          const u = { x0: Math.min(...boxes.map(b => b.x0)), y0: Math.min(...boxes.map(b => b.y0)), x1: Math.max(...boxes.map(b => b.x1)), y1: Math.max(...boxes.map(b => b.y1)) }
          const uw = u.x1 - u.x0, uh = u.y1 - u.y0
          const objPad = brimWidth + skirtOuter + 2
          const towerPad = 4 + edgePad
          let plan: { dx: number; dy: number; x: number; y: number } | null = null
          // Com suporte ligado, galhos de árvore saem alguns milímetros da caixa da peça:
          // tenta-se primeiro com uma folga maior entre peças e torre.
          const supportOn = String(first(R.enable_support as unknown) ?? '0') === '1'
          for (const [depth, sideGap] of [[th, keepGap + 14], [shortDepth, keepGap + 14], [th, keepGap], [shortDepth, keepGap]] as const) {
            if (!supportOn && sideGap !== keepGap) continue
            // torre atrás (Y alto) das peças
            if (!plan && objPad + uh + sideGap + depth + towerPad <= nh && tw + 2 * towerPad <= nw) {
              const dy = objPad - u.y0
              const x = Math.min(Math.max(u.x0 + (uw - tw) / 2, minX), maxX)
              plan = { dx: 0, dy, x, y: u.y1 + dy + sideGap }
            }
            // torre à direita das peças
            if (!plan && objPad + uw + sideGap + tw + towerPad <= nw && depth + 2 * towerPad <= nh) {
              const dx = objPad - u.x0
              const y = Math.min(Math.max(u.y0 + (uh - depth) / 2, minY), Math.max(minY, nh - depth - towerPad))
              plan = { dx, dy: 0, x: u.x1 + dx + sideGap, y }
            }
            if (plan) break
          }
          if (plan) {
            const cur = shifts.get(pid)!
            shifts.set(pid, [cur[0] + plan.dx, cur[1] + plan.dy])
            for (const b of boxes) { b.x0 += plan.dx; b.x1 += plan.dx; b.y0 += plan.dy; b.y1 += plan.dy }
            towers.set(pid, [plan.x, plan.y])
            moved.push(`${multi ? `placa ${pid}: ` : ''}peças deslocadas ${Math.abs(plan.dx + plan.dy).toFixed(0)} mm para ${plan.dx ? 'a esquerda' : 'a frente'} e torre em (${plan.x.toFixed(0)}, ${plan.y.toFixed(0)})`)
            continue
          }
        }
        towerBlocked.add(pid)
        continue
      }
      towers.set(pid, [bx, by])
      moved.push(`${multi ? `placa ${pid}: ` : ''}(${tx.toFixed(0)}, ${ty.toFixed(0)}) → (${bx.toFixed(0)}, ${by.toFixed(0)})`)
    }
    if (moved.length && pids.every(pid => towers.get(pid)![0] !== null && towers.get(pid)![1] !== null)) {
      R.wipe_tower_x = pids.map(pid => fmt(nb[0] + (towers.get(pid)![0] as number), 2))
      R.wipe_tower_y = pids.map(pid => fmt(nb[1] + (towers.get(pid)![1] as number), 2))
      // Vai como AVISO (a interface mostra avisos, não notas): o usuário precisa saber que a
      // torre mudou de lugar para conferir na prévia.
      rep.warnings.push(`Torre de purga reposicionada para não ficar em cima do modelo na mesa da ${printer.label}: ${moved.join('; ')} mm. Confira a posição na prévia do fatiador.`)
    }
  }

  // --- impressão "por objeto" ---
  // Por objeto, o cabeçote termina uma peça antes de começar a outra e precisa de espaço
  // livre em volta (extruder_clearance_radius) e acima (altura até a haste/tampa) — medidas
  // da IMPRESSORA DE DESTINO, diferentes das do projeto original. Se as peças não respeitam
  // essas folgas o fatiador recusa ("is too close to others" / "is too tall"). Nesse caso o
  // projeto passa a "por camada", que não tem risco de colisão do cabeçote.
  const plateSeq = M.plateSequences(modelSettings ?? '')
  const globalSeq = String(first(R.print_sequence as unknown) ?? 'by layer')
  let forceByLayer = false
  let sequenceNeedsUser = false
  {
    const radius = num(first(R.extruder_clearance_radius as unknown)) ?? 0
    const hRod = num(first(R.extruder_clearance_height_to_rod as unknown)) ?? 0
    const hLid = num(first(R.extruder_clearance_height_to_lid as unknown)) ?? 0
    const reasons: string[] = []
    for (const pid of pids) {
      if ((plateSeq.get(pid) ?? globalSeq) !== 'by object') continue
      const boxes = localBoxes.get(pid)!
      if (!boxes.length) continue
      const lab = multi ? `placa ${pid}: ` : ''
      // Só peça x peça. A torre de purga NÃO entra nesta conta: o fatiador não aplica a ela a
      // folga de impressão por objeto (A1_Poop_Bin, uma peça por placa + torre, fatia limpo
      // por objeto na Creator 5; com a torre na conta o motor acusava falta de folga à toa).
      const rects = boxes.slice()
      let close = false
      for (let i = 0; i < rects.length && !close; i++) for (let j = i + 1; j < rects.length; j++) {
        if (rectDistance(rects[i], rects[j]) < radius + 0.5) { close = true; break }
      }
      const heights = boxes.map(b => b.h).sort((a, b) => b - a)
      const tall = (hLid > 0 && heights[0] > hLid) || (hRod > 0 && heights.slice(1).some(h => h > hRod))
      if (close) reasons.push(`${lab}peças a menos de ${radius.toFixed(0)} mm umas das outras`)
      else if (tall) reasons.push(`${lab}peça mais alta que a folga do cabeçote (${hRod.toFixed(0)} mm até a haste, ${hLid.toFixed(0)} mm até a tampa)`)
    }
    // "Por camada" com torre de purga exige a mesma altura de camada em todos os objetos.
    // Se o autor deu alturas diferentes por objeto, nenhuma das duas sequências fatia sem
    // uma decisão do usuário: o projeto fica como está e vira pendência explicada.
    const objectLayerHeights = new Set([...(modelSettings ?? '').matchAll(/<metadata\s+key="layer_height"\s+value="([^"]*)"/g)].map(m => m[1]))
    objectLayerHeights.delete(String(first(R.layer_height as unknown) ?? ''))
    const mixedLayers = objectLayerHeights.size > 0 && towerEnabled() && nfilOut > 1
    if (reasons.length && mixedLayers) {
      const msg = `Impressão "por objeto" não cabe na folga do cabeçote da ${printer.label} (${reasons.slice(0, 3).join('; ')}) e "por camada" exigiria a mesma altura de camada em todas as peças por causa da torre de purga (o autor usou alturas diferentes por objeto). O projeto foi mantido como o autor fez; antes de fatiar, afaste as peças, ou iguale as alturas de camada, ou desligue a torre de purga no fatiador.`
      rep.warnings.push(msg); rep.pending.push(msg)
      sequenceNeedsUser = true
    } else if (reasons.length) {
      R.print_sequence = 'by layer'
      forceByLayer = true
      rep.warnings.push(`Sequência de impressão "por objeto" trocada para "por camada": na ${printer.label} o cabeçote colidiria com peças já impressas (${reasons.slice(0, 3).join('; ')}) e o fatiador recusaria o projeto. Por camada não há esse risco. Para imprimir por objeto, afaste as peças no fatiador e reative a opção.`)
    }
  }

  // Máquinas multi-bico: uma entrada por filamento nas chaves que o fatiador indexa assim.
  if (extruderCount(R) > 1 && nfilOut > 1) {
    for (const [k, v] of Object.entries(MULTI_TOOLHEAD_FILAMENT_DEFAULTS)) {
      const cur = R[k]
      if (!Array.isArray(cur) || cur.length !== nfilOut) R[k] = resize(Array.isArray(cur) && cur.length ? cur : [v], nfilOut)
    }
    // Matriz de purga POR BICO. Em máquinas multi-bico o fatiador espera uma matriz NxN para
    // cada bico (N² x bicos) e um multiplicador por bico; com a matriz única ele avisa "Short
    // flush matrix; using prime-volume fallback" e IGNORA os volumes de purga do autor. A
    // matriz do autor é repetida para cada bico, sem alterar nenhum volume.
    const toolheads = extruderCount(R)
    const fm = R.flush_volumes_matrix
    if (Array.isArray(fm) && fm.length === nfilOut * nfilOut) {
      R.flush_volumes_matrix = Array.from({ length: toolheads }, () => fm).flat()
      const mult = Array.isArray(R.flush_multiplier) ? (R.flush_multiplier as unknown[]) : [R.flush_multiplier ?? '1']
      R.flush_multiplier = resize(mult.length ? mult : ['1'], toolheads)
      rep.notes.push(`Matriz de purga repetida para os ${toolheads} bicos da ${printer.label} (formato que o fatiador exige em máquinas multi-bico); os volumes do autor não mudaram.`)
    }
  }

  // Presets embutidos do projeto de origem (Metadata/filament_settings_N.config etc.) são
  // presets personalizados da impressora/filamento do AUTOR. No destino todos os valores já
  // estão no project_settings com os presets Flashforge, e o Flash Studio falha ao carregar
  // esses arquivos quando trazem campos nulos ("Deserializing nil into a non-nullable object").
  const embeddedPresets = namesIn.filter(n => M.EMBEDDED_PRESET_RE.test(n))
  const removed = namesIn.filter(n => M.CACHE_RE.test(n) || M.EMBEDDED_PRESET_RE.test(n))
  rep.removed_files = removed
  if (embeddedPresets.length) rep.notes.push(`Presets personalizados embutidos do projeto de origem não foram levados (${embeddedPresets.slice(0, 4).join(', ')}): pertencem à impressora/filamento de origem e os valores usados já estão no projeto convertido.`)
  let unassigned = 0
  const version = String(T.version ?? '2.3.2')

  // --- gravação (gera o 3MF novo) ---
  const zout = new JSZip()
  const customGcodeXyStats: Record<string, M.CustomGcodeStats> = {}
  let customGcodeDropped = 0
  let customGcodeOffBed = false

  // Anexos (fotos do modelo em Auxiliaries/) com nome fora do ASCII ou longo demais: o Flash
  // Studio no Windows não consegue extraí-los ("Error while extract auxiliary file to file"),
  // inclusive no projeto original. O conteúdo é mantido; só o nome do arquivo é simplificado.
  const auxRename = new Map<string, string>()
  {
    const taken = new Set(namesIn)
    for (const name of namesIn) {
      if (!name.startsWith('Auxiliaries/') || zin.files[name].dir) continue
      const cut = name.lastIndexOf('/')
      const base = name.slice(cut + 1)
      if (!/[^ -~]/.test(base) && base.length <= 100) continue
      const dot = base.lastIndexOf('.')
      const ext = dot > 0 ? base.slice(dot).replace(/[^A-Za-z0-9.]/g, '') : ''
      const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/[^ -~]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'anexo'
      let candidate = `${name.slice(0, cut + 1)}${stem}${ext}`
      for (let i = 2; taken.has(candidate); i++) candidate = `${name.slice(0, cut + 1)}${stem}_${i}${ext}`
      taken.add(candidate)
      auxRename.set(name, candidate)
    }
    if (auxRename.size) rep.notes.push(`${auxRename.size} anexo(s) em Auxiliaries/ tinham nome com caracteres especiais ou longo demais para o Flash Studio no Windows; o nome do arquivo foi simplificado (conteúdo intacto).`)
  }
  const renameAuxRefs = (txt: string): string => {
    for (const [from, to] of auxRename) txt = txt.split(from).join(to)
    return txt
  }

  for (const [name, entry] of Object.entries(zin.files)) {
    if (entry.dir) continue
    if (removed.includes(name)) continue
    let data: Uint8Array | string = await entry.async('uint8array')
    if (name === SETTINGS) {
      data = JSON.stringify(stringifySettingValues(R, rep), null, 4)
    } else if (name === M.MODEL_SETTINGS) {
      let txt = new TextDecoder().decode(data)
      if (fixes.size) txt = M.rebaseExtruders(txt, fixes, rebase)
      txt = M.remapModelSettings(txt, keepIdx ?? Array.from({ length: nfil }, (_, i) => i + 1), mp.perFeatureFilamentKeys)
      if (Object.keys(mirror).length) txt = M.mirrorObjectKeys(txt, mirror)
      if (forceByLayer) txt = M.setPlateSequences(txt, 'by layer')
      if (hybridTreeRewrite) txt = M.rewriteMetadataValue(txt, 'support_style', ['tree_organic'], 'tree_hybrid')
      txt = M.stripPlateBedType(txt)
      data = txt
    } else if (name === M.CUSTOM_GCODE) {
      let txt = new TextDecoder().decode(data)
      if (keepIdx) {
        const map = new Map<number, number>(keepIdx.map((o, i) => [o, i + 1]))
        txt = M.remapCustomGcode(txt, map)
      }
      if (merged) {
        const r = M.dropCustomGcodeTypes(txt, new Set(['2']))
        txt = r.text; customGcodeDropped = r.removed
      }
      if (ow && M.customGcodeXyEntries(txt) && ob) {
        const offs: Record<string, [number, number]> = {}
        for (const pid of pids) {
          offs[String(pid)] = [shifts.get(pid)![0] - ob[0] + nb[0], shifts.get(pid)![1] - ob[1] + nb[1]]
        }
        const result = M.translateCustomGcode(txt, offs)
        txt = result.text
        Object.assign(customGcodeXyStats, result.stats)
      }
      data = txt
    } else if (merged && /\.model$/i.test(name) && name !== M.ROOT_MODEL) {
      data = M.stripColorPaint(data as Uint8Array)
    } else if (name === M.ROOT_MODEL) {
      if (merged) data = M.stripColorPaint(data as Uint8Array)
      let txt = new TextDecoder().decode(data as Uint8Array)
      if (/<metadata name="Application">/.test(txt)) {
        txt = txt.replace(/(<metadata name="Application">)[^<]*/, (_m, pre: string) => pre + 'BambuStudio-' + version)
      } else {
        // 3MF sem o metadado Application (gerado por scripts/outros programas): o Orca e o
        // Flash Studio reconhecem o projeto por esse prefixo, então ele é acrescentado.
        txt = txt.replace(/(<model\b[^>]*>)/, (_m, open: string) => `${open}\n <metadata name="Application">BambuStudio-${version}</metadata>`)
        rep.notes.push('O 3MF de origem não trazia o metadado Application; foi acrescentado para o fatiador reconhecer o projeto.')
      }
      if (ow && ob) {
        txt = M.mapBuildItems(txt, (tag, index) => {
          let tm = /transform="([^"]+)"/.exec(tag)
          if (!tm) {
            // Item sem transformação = identidade; ganha uma para poder ser posicionado.
            tag = tag.replace(/\s*\/?>$/, m => ` transform="1 0 0 0 1 0 0 0 1 0 0 0"${m.trim() === '/>' ? '/>' : '>'}`)
            tm = /transform="([^"]+)"/.exec(tag)
            if (!tm) return tag
          }
          const parts = tm[1].split(/\s+/)
          if (parts.length !== 12) return tag
          const pid = itemPlate.get(index)
          if (pid === undefined) { unassigned += 1; return tag }
          const [dx, dy] = shifts.get(pid)!
          const [ox, oy] = oldOrg.get(pid) ?? [0, 0]
          const [nx, ny] = newOrg.get(pid) ?? [0, 0]
          const x = parseFloat(parts[9]), y = parseFloat(parts[10])
          parts[9] = fmt(x - ox - ob![0] + nx + nb[0] + dx, 5)
          parts[10] = fmt(y - oy - ob![1] + ny + nb[1] + dy, 5)
          return tag.replace(tm[0], `transform="${parts.join(' ')}"`)
        })
      }
      data = txt
    } else if (name.endsWith('.rels') && removed.length) {
      data = M.cleanRels(new TextDecoder().decode(data as Uint8Array), removed)
    }
    if (auxRename.size && typeof data === 'string' && (name === M.ROOT_MODEL || name.endsWith('.rels'))) data = renameAuxRefs(data)
    zout.file(auxRename.get(name) ?? name, typeof data === 'string' ? data : data)
  }

  // Scrub .rels entries que apontam para arquivos ausentes no zip de saída.
  // Captura tanto os caches removidos pelo conversor quanto refs pendentes que
  // já vinham quebradas da entrada (ex.: 3MF do MakerWorld com
  // Metadata/_rels/model_settings.config.rels -> /Metadata/plate_N.gcode
  // sem o G-code gravado). Sem esse scrub, a validação
  // `rels_sem_referencia_quebrada` aborta a conversão.
  const outNames = new Set(Object.keys(zout.files).filter(n => !zout.files[n].dir))
  const danglingRels: Array<{ rels: string; target: string }> = []
  for (const name of [...outNames]) {
    if (!name.endsWith('.rels')) continue
    const txt = await zout.file(name)!.async('string')
    const { text, dropped } = M.dropDanglingRels(txt, outNames)
    if (dropped.length) {
      zout.file(name, text)
      for (const t of dropped) danglingRels.push({ rels: name, target: t })
    }
  }
  if (danglingRels.length) {
    const targets = danglingRels.map(d => d.target)
    const uniqueTargets = Array.from(new Set(targets))
    rep.removed_files = Array.from(new Set([
      ...rep.removed_files,
      ...uniqueTargets.map(t => `<rel>${t}`),
    ]))
    const preview = uniqueTargets.slice(0, 3).join(', ')
    rep.notes.push(
      `Removidas ${danglingRels.length} referência(s) pendente(s) de .rels no 3MF de entrada (ex.: ${preview}${uniqueTargets.length > 3 ? '…' : ''}). O 3MF original listava caches de fatiamento que não estavam dentro do arquivo; o 3MF de saída foi limpo.`
    )
  }
  if (unassigned) rep.warnings.push(`${unassigned} objeto(s) sem placa identificável: posição não ajustada, confira no fatiador.`)
  for (const pidS of Object.keys(customGcodeXyStats).sort()) {
    const st = customGcodeXyStats[pidS]
    const lab = multi ? `Placa ${pidS}: ` : ''
    const bb = st.bbox
    if (st.moves) {
      const [dx, dy] = (shifts.get(parseInt(pidS, 10)) ?? [0, 0])
      rep.warnings.push(`${lab}o G-code custom por camada tem ${st.moves} movimento(s) XY absolutos; foram transladados junto com o objeto (Δx ${dx >= 0 ? '+' : ''}${dx.toFixed(1)}, Δy ${dy >= 0 ? '+' : ''}${dy.toFixed(1)} mm). Confira na prévia.`)
    }
    if (st.relative) {
      const msg = `${lab}o G-code custom por camada usa coordenadas relativas (G91): esses trechos não foram transladados; confira na prévia.`
      rep.warnings.push(msg); rep.pending.push(msg)
    }
    if (bb && bb.every(v => v !== null)) {
      const [b0, b1, b2, b3] = bb as number[]
      if (b0 < nb[0] - 0.5 || b1 < nb[1] - 0.5 || b2 > nb[2] + 0.5 || b3 > nb[3] + 0.5) {
        const msg = `${lab}mesmo transladado, o G-code custom por camada sai da mesa da ${printer.label} (X ${b0.toFixed(1)}..${b2.toFixed(1)}, Y ${b1.toFixed(1)}..${b3.toFixed(1)}; mesa ${nb[0].toFixed(0)}..${nb[2].toFixed(0)} x ${nb[1].toFixed(0)}..${nb[3].toFixed(0)}). O fatiador vai recusar: remova/edite esse G-code (comum em arquivos de calibração).`
        rep.warnings.push(msg); rep.pending.push(msg); customGcodeOffBed = true
      }
    }
  }

  // 7) checagens de encaixe por placa
  for (const pid of pids) {
    const { fit, mod, height } = boxes.get(pid)!
    const tower = towers.get(pid)!
    const prow: PlateRow = {
      id: pid, shift_mm: [Math.round(shifts.get(pid)![0] * 100) / 100, Math.round(shifts.get(pid)![1] * 100) / 100],
      prime_tower_local: tower.map(v => v !== null ? Math.round(v * 100) / 100 : null), fits: true,
    }
    const lab = multi ? `Placa ${pid}: ` : ''
    if (height !== null && maxH && height > maxH + 0.01) {
      prow.fits = false
      const msg = `${lab}o modelo tem ${height.toFixed(0)} mm de altura, acima dos ${maxH.toFixed(0)} mm da ${printer.label}.`
      rep.warnings.push(msg); rep.pending.push(msg)
    }
    if (fit) {
      const [dx, dy] = shifts.get(pid)!
      const x0 = fit[0] + dx, y0 = fit[1] + dy, x1 = fit[2] + dx, y1 = fit[3] + dy
      const mw = mod ? (mod[2] - mod[0]) : null
      const mh = mod ? (mod[3] - mod[1]) : null
      prow.size_mm = [Math.round((x1 - x0) * 10) / 10, Math.round((y1 - y0) * 10) / 10]
      if (mod && mw !== null && mh !== null && (mw > nw || mh > nh)) {
        prow.fits = false
        const pct = Math.trunc(Math.min(nw / mw, nh / mh) * 100 * 0.95)
        const msg = `${lab}o modelo tem ${mw.toFixed(0)} x ${mh.toFixed(0)} mm, maior que a mesa de ${nw.toFixed(0)} x ${nh.toFixed(0)} mm da ${printer.label}. Escale para ~${pct}% ou divida antes de fatiar.`
        rep.warnings.push(msg); rep.pending.push(msg)
      } else if (x0 < -0.01 || y0 < -0.01 || x1 > nw + 0.01 || y1 > nh + 0.01) {
        prow.fits = false
        rep.warnings.push(`${lab}modelo + torre de purga (${(x1 - x0).toFixed(0)} x ${(y1 - y0).toFixed(0)} mm) não cabem na mesa de ${nw.toFixed(0)} x ${nh.toFixed(0)} mm; mova a torre/modelo no fatiador.`)
      } else {
        if (towerBlocked.has(pid) && towerEnabled()) {
          if (plateFilaments(pid) > 1) {
            const msg = `${lab}não há espaço livre na mesa para a torre de purga sem encostar no modelo; mova ou reduza a torre (ou o modelo) no fatiador antes de fatiar.`
            rep.warnings.push(msg); rep.pending.push(msg)
          } else {
            // Placa de um filamento só: a torre não é impressa nela, então nada impede o
            // fatiamento; o fatiador só registra que a torre "está perto" das peças.
            rep.warnings.push(`${lab}a torre de purga não tem lugar livre nesta mesa, mas a placa usa um filamento só e a torre não é impressa nela. O fatiador pode avisar que a torre está perto das peças ("Prime Tower is too close to others"); pode ignorar nesta placa ou arrastar a torre para fora do caminho.`)
          }
        }
      }
    }
    rep.plates.push(prow)
  }

  rep.preserved = {
    thumbnails: namesIn.filter(n => n.toLowerCase().endsWith('.png') && !removed.includes(n)).sort(),
    custom_gcode_per_layer: namesIn.includes(M.CUSTOM_GCODE),
    painted_supports: paintSup,
    painted_colors: paintedColors,
    mesh_and_paint_untouched: 'verificado na validação (hash normalizado dos .model)',
  }

  const output = await zout.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 1 } })
  return {
    output,
    ctx: {
      mapping: mp, nfil_out: nfilOut, slots: printer.slots,
      strip_paint: merged, custom_gcode_dropped: customGcodeDropped,
      custom_gcode_xy: Object.keys(customGcodeXyStats).length ? customGcodeXyStats : undefined,
      custom_gcode_off_bed: customGcodeOffBed,
    },
  }
}
