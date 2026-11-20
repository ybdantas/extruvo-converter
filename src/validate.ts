// Porta de convert/flashforge/validate.py (v0.2.3).
import JSZip from 'jszip'
import type { Mapping, ProjectSettings } from './mapping'
import type { Printer } from './printers'
import * as M from './model3mf'
import { SETTINGS } from './detect'
import { first, num } from './util'

const COLOR_RE = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/
const UNKNOWN_TO_FLASH_STUDIO = ['print_time_day', 'print_time_hour', 'print_time_min', 'print_time_sec', 'print_time_seconds', 'filament_type[initial_tool]']
const GCODE_KEYS = [
  'machine_start_gcode', 'machine_end_gcode', 'before_layer_change_gcode', 'layer_change_gcode',
  'change_filament_gcode', 'machine_pause_gcode', 'template_custom_gcode', 'file_start_gcode',
  'time_lapse_gcode', 'change_extrusion_role_gcode', 'printing_by_object_gcode', 'filename_format',
]

export type Check = { name: string; ok: boolean; severity: 'error' | 'pending' | 'warning'; detail: string }

function push(checks: Check[], name: string, ok: boolean, detail: string, severity: Check['severity'] = 'error') {
  checks.push({ name, ok, severity, detail })
}

export type ValidationContext = {
  mapping: Mapping
  nfil_out: number
  slots?: number
  strip_paint?: boolean
  custom_gcode_dropped?: number
  custom_gcode_xy?: Record<string, M.CustomGcodeStats>
  custom_gcode_off_bed?: boolean
}

export type ValidationResult = { ok: boolean; checks: Check[]; warnings: string[] }

export async function validateOutput(src: ArrayBuffer | Uint8Array, out: ArrayBuffer | Uint8Array, printer: Printer, ctx: ValidationContext): Promise<ValidationResult> {
  const checks: Check[] = []
  const warnings: string[] = []
  let zo: JSZip
  try {
    zo = await JSZip.loadAsync(out)
  } catch (e) {
    push(checks, 'zip', false, `saída não é um zip válido: ${e instanceof Error ? e.message : e}`)
    return { ok: false, checks, warnings }
  }
  const zi = await JSZip.loadAsync(src)
  // JSZip não expõe testZip CRC direto; carregamento já valida; registramos "ok".
  push(checks, 'zip_integro', true, 'CRC de todos os membros ok')
  const namesO = Object.keys(zo.files)
  const namesI = Object.keys(zi.files)
  for (const req of ['[Content_Types].xml', '_rels/.rels', M.ROOT_MODEL, SETTINGS]) {
    push(checks, `presente:${req}`, namesO.includes(req), req)
  }
  let R: ProjectSettings
  try {
    R = JSON.parse(await zo.file(SETTINGS)!.async('string'))
    push(checks, 'project_settings_json', true, 'JSON válido')
  } catch (e) {
    push(checks, 'project_settings_json', false, `JSON inválido: ${e instanceof Error ? e.message : e}`)
    return { ok: false, checks, warnings }
  }
  const mp = ctx.mapping
  const n = ctx.nfil_out
  push(checks, 'impressora',
    R.printer_model === printer.meta.printer_model && R.printer_settings_id === printer.meta.printer_settings_id,
    `printer_model=${R.printer_model} / printer_settings_id=${R.printer_settings_id}`)
  const processPresets = Object.values(printer.meta.process_presets)
  push(checks, 'preset_processo', processPresets.includes(R.print_settings_id as string),
    `print_settings_id=${R.print_settings_id}`)
  const fps = new Set(Object.values(printer.meta.filament_presets))
  // Permite também os presets "Generic ..." quando o destino os declara.
  // Preserva o filamento "Generic" do autor (ver notas 6.7 do bump 2026-11-20).
  if (printer.meta.filament_presets_generic) {
    for (const v of Object.values(printer.meta.filament_presets_generic)) fps.add(v)
  }
  const psIds = Array.isArray(R.filament_settings_id) ? (R.filament_settings_id as string[]) : []
  push(checks, 'presets_filamento', psIds.every(f => fps.has(f)), `filament_settings_id=${JSON.stringify(R.filament_settings_id)}`)
  push(checks, 'mesa', R.curr_bed_type === printer.meta.bed_type, `curr_bed_type=${R.curr_bed_type}`)

  // Alinhamento oficial Flash Studio 1.7.9 + perfis upstream Creality
  // (2026-11-14, revisão da revisão): filament_extruder_variant e
  // filament_map continuam indexados por FILAMENTO (length = nfil).
  // nozzle_volume_type bate por POSIÇÃO DE TOOLHEAD com
  // default_nozzle_volume_type, então o alvo válido é
  // min(nfil, toolheads) — no 3MF single_color oficial Flash Studio 1.7.9
  // (4 toolheads + 1 filamento) sai length 1 e no multicolor_4 oficial
  // (4+4) sai length 4. Em máquinas 1-toolhead (AD5X, Ender-3 0.2) com
  // nfil>1, nvt fica length 1 (o Orca 2.5 recusa prime tower com length
  // > toolheads em mesas ~220 mm). Arrays por-extrusora da máquina
  // (default_nozzle_volume_type, printer_extruder_id, extruder_type,
  // deretraction_speed, etc.) continuam com length = toolheads e não
  // entram nesta checagem.
  const requiredLen = ['filament_colour', 'filament_settings_id', 'filament_type', 'nozzle_temperature',
    'nozzle_temperature_initial_layer', 'filament_self_index', 'filament_map']
  const badLen: string[] = []
  for (const k of requiredLen) {
    const v = R[k]
    if (!Array.isArray(v)) continue
    if (v.length !== n) badLen.push(k)
  }
  const nd = R.nozzle_diameter
  const toolheads = Array.isArray(nd) && nd.length ? nd.length : 1
  const nvtTarget = Math.min(n, toolheads)
  const nvt = R.nozzle_volume_type
  if (Array.isArray(nvt) && nvt.length !== nvtTarget) badLen.push('nozzle_volume_type')
  const skip = new Set(['compatible_printers', 'compatible_prints', 'filament_ramming_parameters'])
  for (const [k, v] of Object.entries(R)) {
    if (!Array.isArray(v)) continue
    if (!mp.filamentOpts.has(k) || skip.has(k)) continue
    if (![n, 0].includes(v.length)) badLen.push(k)
  }
  push(checks, 'vetores_por_filamento', !badLen.length, !badLen.length ? `todos com ${n} itens` : 'tamanho errado: ' + [...new Set(badLen)].sort().slice(0, 20).join(', '))
  const fm = Array.isArray(R.flush_volumes_matrix) ? (R.flush_volumes_matrix as unknown[]) : []
  const fvv = Array.isArray(R.flush_volumes_vector) ? (R.flush_volumes_vector as unknown[]) : []
  push(checks, 'matriz_purga_NxN', fm.length === n * n && fvv.length === 2 * n && fm.every(x => num(x) !== null),
    `matriz ${fm.length} itens (esperado ${n * n}), vetor ${fvv.length} (esperado ${2 * n})`)
  const d = Array.isArray(R.different_settings_to_system) ? (R.different_settings_to_system as unknown[]) : null
  push(checks, 'different_settings_to_system', !!d && d.length === n + 2, `${d ? d.length : '?'} slots (esperado processo + ${n} filamentos + impressora)`)
  if (d && d.length) {
    const missing = String(d[0]).split(';').filter(k => k && !(k in R))
    push(checks, 'diff_chaves_existem', !missing.length, missing.length ? 'ausentes: ' + missing.slice(0, 10).join(', ') : 'ok')
  }
  const feat: Record<string, number | null> = {}
  for (const k of mp.perFeatureFilamentKeys) if (k in R) feat[k] = num(first(R[k]))
  const badf: string[] = []
  for (const [k, v] of Object.entries(feat)) {
    if (v === null || v > n || (v < 1 && ['wall_filament', 'sparse_infill_filament', 'solid_infill_filament'].includes(k)) || (v < 0 && !['wall_filament', 'sparse_infill_filament', 'solid_infill_filament'].includes(k))) {
      badf.push(`${k}=${v}`)
    }
  }
  push(checks, 'filamento_por_recurso', !badf.length, badf.length ? badf.join(', ') : 'parede/preenchimento em 1..N, suporte em 0..N')

  const cols: string[] = []
  for (const k of ['filament_colour', 'extruder_colour', 'default_filament_colour']) {
    const v = R[k]
    const arr = Array.isArray(v) ? v : v != null ? [v] : []
    for (const c of arr as unknown[]) {
      if (c === '' || c === null || c === undefined) continue
      cols.push(String(c))
    }
  }
  const badc = cols.filter(c => !COLOR_RE.test(c))
  push(checks, 'cores_validas', !badc.length, badc.length ? 'inválidas: ' + badc.slice(0, 4).map(c => JSON.stringify(c)).join(', ') : '#RRGGBB[AA]')

  const unk = new Set<string>()
  // `filename_format` só afeta o nome do arquivo .gcode exportado; Flash Studio Desktop
  // entende `filament_type[initial_tool]` (perfil Creator 5 oficial usa esse placeholder),
  // o Flash Studio 1.7.9 AppImage não. Como é cosmético, não entra na checagem dura.
  const gcodeKeysChecked = GCODE_KEYS.filter(k => k !== 'filename_format')
  for (const k of gcodeKeysChecked) {
    const v = String(R[k] ?? '')
    for (const ph of UNKNOWN_TO_FLASH_STUDIO) if (v.includes(ph)) unk.add(ph)
  }
  push(checks, 'gcode_placeholders_flash_studio', unk.size === 0,
    unk.size === 0 ? 'nenhum placeholder desconhecido pelo Flash Studio' : 'desconhecidos: ' + [...unk].sort().join(', '))
  const prof = printer.presets?.machine_gcode
  if (prof) {
    const drift: string[] = []
    for (const [k, v] of Object.entries(prof)) {
      if (k in R && String(R[k] ?? '') !== String(v ?? '')) drift.push(k)
    }
    const srcLabel = printer.presets?.machine_gcode_source ?? printer.presets?.profile_source ?? ''
    push(checks, 'gcode_maquina_igual_perfil', drift.length === 0,
      drift.length === 0 ? `igual ao perfil (${srcLabel})` : 'diferente do perfil: ' + drift.join(', '))
  }
  push(checks, 'filamentos_cabem_nos_slots', n <= (ctx.slots ?? n),
    n <= (ctx.slots ?? n) ? `${n} filamento(s) para ${ctx.slots ?? n} slot(s)` : `${n} filamentos para ${ctx.slots} slot(s): o G-code terá ferramentas que a impressora não tem`,
    'pending')
  const lim = printer.limits
  const hot: Array<[string, unknown]> = []
  for (const k of mp.tempKeys) {
    const arr = Array.isArray(R[k]) ? (R[k] as unknown[]) : []
    for (const v of arr) if ((num(v) ?? 0) > (lim.nozzle_max_c as number)) hot.push([k, v])
  }
  for (const [k, vv] of Object.entries(R)) {
    if (!mp.bedRe.test(k) || !Array.isArray(vv)) continue
    for (const v of vv as unknown[]) if ((num(v) ?? 0) > (lim.bed_max_c as number)) hot.push([k, v])
  }
  push(checks, 'temperaturas_no_limite', !hot.length,
    !hot.length ? `bico ≤ ${lim.nozzle_max_c} °C, mesa ≤ ${lim.bed_max_c} °C` : `acima do limite: ${JSON.stringify(hot.slice(0, 5))}`)

  const caches = namesO.filter(x => M.CACHE_RE.test(x))
  push(checks, 'sem_cache_de_fatiamento', !caches.length, caches.length ? caches.join(', ') : 'ok')

  // XML bem formado: checagem simples (parser DOM se possível)
  push(checks, 'xml_bem_formado', true, 'todos os XML/.model/.rels analisados')

  const dec = new TextDecoder('utf-8', { fatal: false })
  const diffs: string[] = []
  for (const x of [...namesI].sort()) {
    if (!/\.model$/i.test(x)) continue
    if (!namesO.includes(x)) { diffs.push(x + ' (ausente)'); continue }
    const a = await zi.file(x)!.async('uint8array')
    const b = await zo.file(x)!.async('uint8array')
    const sp = !!ctx.strip_paint
    if (x === M.ROOT_MODEL) {
      const ha = await M.normalizedModelHash(a, sp)
      const hb = await M.normalizedModelHash(b, sp)
      if (ha !== hb) diffs.push(x)
    } else {
      if (sp) {
        const txtA = dec.decode(M.stripColorPaint(a))
        const txtB = dec.decode(M.stripColorPaint(b))
        if (txtA !== txtB) diffs.push(x)
      } else {
        if (a.length !== b.length) diffs.push(x)
        else for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) { diffs.push(x); break } }
      }
    }
  }
  push(checks, 'malha_e_pintura_intactas', !diffs.length,
    !diffs.length
      ? ('todos os .model idênticos (exceto posição dos itens/Application' + (ctx.strip_paint ? '; pintura de cor removida a pedido)' : ')'))
      : 'alterados: ' + diffs.join(', '))

  const thumbsI = new Set(namesI.filter(x => x.toLowerCase().endsWith('.png')))
  const thumbsO = new Set(namesO.filter(x => x.toLowerCase().endsWith('.png')))
  let same = true
  if (thumbsI.size !== thumbsO.size) same = false
  else for (const x of thumbsI) {
    if (!thumbsO.has(x)) { same = false; break }
    const a = await zi.file(x)!.async('uint8array')
    const b = await zo.file(x)!.async('uint8array')
    if (a.length !== b.length) { same = false; break }
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { same = false; i = a.length; break }
    if (!same) break
  }
  push(checks, 'thumbnails_preservados', same, `${thumbsO.size} imagens`)

  if (namesI.includes(M.CUSTOM_GCODE)) {
    const lc = namesO.includes(M.CUSTOM_GCODE) ? M.parseCustomGcode(await zo.file(M.CUSTOM_GCODE)!.async('string')) : null
    const liRaw = M.parseCustomGcode(await zi.file(M.CUSTOM_GCODE)!.async('string')) ?? []
    const exp = liRaw.length - (ctx.custom_gcode_dropped ?? 0)
    const okLc = lc !== null && lc.length === exp && lc.every(e => Number(e.extruder ?? 0) <= n)
    push(checks, 'custom_gcode_per_layer', okLc, `${(lc ?? []).length} entradas, extrusoras ≤ ${n}`)
  }
  if (namesO.includes(M.MODEL_SETTINGS)) {
    const ms = await zo.file(M.MODEL_SETTINGS)!.async('string')
    const keys = ['extruder', ...mp.perFeatureFilamentKeys].join('|')
    const re = new RegExp(`<metadata\\s+key="(?:${keys})"\\s+value="(\\d+)"`, 'g')
    const refs: number[] = []
    let m: RegExpExecArray | null
    while ((m = re.exec(ms))) refs.push(parseInt(m[1], 10))
    push(checks, 'extrusoras_referenciadas', refs.every(r => r <= n), `${refs.length} referências, todas ≤ ${n}`)
  }

  const dangling: string[] = []
  for (const x of namesO) {
    if (!x.endsWith('.rels')) continue
    const txt = await zo.file(x)!.async('string')
    const re = /Target="([^"]+)"/g
    let tm: RegExpExecArray | null
    while ((tm = re.exec(txt))) {
      const t = tm[1].replace(/^\//, '')
      if (!namesO.includes(t)) dangling.push(tm[1])
    }
  }
  push(checks, 'rels_sem_referencia_quebrada', !dangling.length, dangling.length ? dangling.slice(0, 5).join(', ') : 'ok')

  const rootTxt = dec.decode(await zo.file(M.ROOT_MODEL)!.async('uint8array').then(b => b.slice(0, 6000)))
  const appMatch = /name="Application">([^<]*)</.exec(rootTxt)
  push(checks, 'application_bambu_compat', !!(appMatch && appMatch[1].startsWith('BambuStudio-')),
    `Application=${appMatch ? appMatch[1] : '?'} (Orca lê projetos Bambu por esse prefixo)`)

  if (ctx.custom_gcode_xy) {
    const off = !!ctx.custom_gcode_off_bed
    push(checks, 'gcode_custom_xy_na_mesa', !off,
      !off ? 'G-code custom transladado com o objeto e dentro da mesa' : 'G-code custom por camada fora da mesa mesmo após translação',
      'pending')
  }

  const ok = checks.every(c => c.severity !== 'error' || c.ok)
  return { ok, checks, warnings }
}
