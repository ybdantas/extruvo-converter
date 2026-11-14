#!/usr/bin/env node
// Porta Node de tools/build_templates.py do pacote extruvo-flashforge-converter-ref v0.2.3.
// Gera templates planos (project_settings.config) para as impressoras Flashforge adicionadas,
// resolvendo a herança de perfil (processo -> filamento -> máquina) a partir dos perfis oficiais
// do Flash Studio Desktop ou, quando aplicável, do Flash Studio AppImage. A pasta de origem precisa
// conter machine/, process/ e filament/ em JSON (o Flash Studio Desktop é o caso canônico).
//
// Uso:
//   node modules/extruvo-converter/scripts/build-templates.mjs \
//     --profiles "C:/Program Files/FlashForge/Flash Studio Desktop/resources/profiles/Flashforge" \
//     --source-label "Flash Studio Desktop (vendor Flashforge Windows)"
//
// IMPORTANTE: os perfis OrcaSlicer/Flash Studio são AGPL-3.0. O JSON gerado é dado derivado.
// Veja NOTICE no módulo.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import url from 'node:url'

const META = new Set([
  'type', 'instantiation', 'setting_id', 'description', 'renamed_from', 'compatible_printers',
  'compatible_printers_condition', 'compatible_prints', 'compatible_prints_condition', 'filament_id',
  'base_id',
])
// OVERLAY_SKIP = chaves de perfil de máquina que NÃO entram num overlay AD5X
// (ver tools/build_templates.py do pacote Python). Mantido como referência;
// não usamos --ad5x-machine-overlay aqui, por isso o lint ignora via prefixo _.
const _OVERLAY_SKIP = new Set([
  ...META, 'name', 'inherits', 'from', 'printer_model', 'printer_settings_id',
  'default_print_profile', 'default_filament_profile', 'printer_variant', 'version',
  'printer_notes', 'thumbnails_format',
])
void _OVERLAY_SKIP
const SPEED_KEYS = ['sparse_infill_speed', 'internal_solid_infill_speed', 'gap_infill_speed']
const GCODE_KEYS = [
  'machine_start_gcode', 'machine_end_gcode', 'before_layer_change_gcode', 'layer_change_gcode',
  'change_filament_gcode', 'machine_pause_gcode', 'template_custom_gcode', 'file_start_gcode',
  'time_lapse_gcode', 'change_extrusion_role_gcode', 'printing_by_object_gcode', 'filename_format',
]

const FILAMENTS_C5 = {
  PLA: 'Flashforge PLA Basic @FF C5',
  'PLA-CF': 'Flashforge PLA-CF @FF C5',
  PETG: 'Flashforge PETG Pro @FF C5',
  'PETG-CF': 'Flashforge PETG-CF @FF C5',
  ABS: 'Flashforge ABS Basic @FF C5',
  ASA: 'Flashforge ASA Basic @FF C5',
  TPU: 'Flashforge TPU-95A @FF C5',
}
const FILAMENTS_C5P = {
  PLA: 'Flashforge PLA Basic @FF C5P',
  'PLA-CF': 'Flashforge PLA-CF @FF C5P',
  PETG: 'Flashforge PETG Pro @FF C5P',
  'PETG-CF': 'Flashforge PETG-CF @FF C5P',
  ABS: 'Flashforge ABS Basic @FF C5P',
  ASA: 'Flashforge ASA Basic @FF C5P',
  TPU: 'Flashforge TPU-95A @FF C5P',
}

const TARGETS = {
  creator5: {
    machine: 'Flashforge Creator 5 0.4 nozzle',
    process: '0.20mm Standard @FF C5',
    filament: 'Flashforge PLA Basic @FF C5',
    label: 'Flashforge Creator 5',
    filaments: FILAMENTS_C5,
  },
  creator5pro: {
    machine: 'Flashforge Creator 5 Pro 0.4 nozzle',
    process: '0.20mm Standard @FF C5',
    filament: 'Flashforge PLA Basic @FF C5P',
    label: 'Flashforge Creator 5 Pro',
    filaments: FILAMENTS_C5P,
  },
}

function indexProfiles(rootsArg) {
  const roots = Array.isArray(rootsArg) ? rootsArg : [rootsArg]
  const idx = new Map()
  const walk = (dir, kind) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        const nextKind = kind || (['machine', 'process', 'filament'].includes(ent.name) ? ent.name : '')
        walk(p, nextKind)
      } else if (ent.name.endsWith('.json') && kind) {
        try {
          const j = JSON.parse(fs.readFileSync(p, 'utf-8'))
          if (j && typeof j === 'object' && j.name && !idx.has(kind + '::' + j.name)) {
            idx.set(kind + '::' + j.name, j)
          }
        } catch { /* skip bad JSON */ }
      }
    }
  }
  for (const root of roots) walk(root, '')
  return idx
}

function resolveInherits(idx, kind, name, seen = new Set()) {
  const j = idx.get(kind + '::' + name)
  if (!j) throw new Error(`perfil ${kind}/${name} não encontrado`)
  if (seen.has(name)) throw new Error('herança circular: ' + name)
  const base = j.inherits ? resolveInherits(idx, kind, j.inherits, new Set([...seen, name])) : {}
  return { ...base, ...j }
}

function areaOrigin(arr) {
  const pts = arr.map(p => String(p).split('x').map(Number))
  return [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1]))]
}

function build(idx, spec, skeleton) {
  const proc = resolveInherits(idx, 'process', spec.process)
  const fil = resolveInherits(idx, 'filament', spec.filament)
  const mach = resolveInherits(idx, 'machine', spec.machine)
  const R = {}
  for (const [k, v] of Object.entries(skeleton)) R[k] = structuredClone(v)
  for (const src of [proc, fil, mach]) {
    for (const [k, v] of Object.entries(src)) {
      if (META.has(k) || k === 'name' || k === 'inherits' || k === 'from') continue
      R[k] = structuredClone(v)
    }
  }
  R.default_filament_profile = [spec.filament]
  R.print_settings_id = spec.process
  R.printer_settings_id = spec.machine
  R.filament_settings_id = [spec.filament]
  R.printer_model = mach.printer_model ?? R.printer_model
  delete R.inherits
  R.version = skeleton.version ?? '2.3.2'
  if (skeleton.from) R.from = skeleton.from
  try {
    const [sx, sy] = areaOrigin(skeleton.printable_area)
    const [dx, dy] = areaOrigin(R.printable_area)
    for (const [k, oS, oD] of [['wipe_tower_x', sx, dx], ['wipe_tower_y', sy, dy]]) {
      const v = skeleton[k]
      const vals = Array.isArray(v) ? v : [v]
      R[k] = vals.map(x => String(Number(x) - oS + oD))
    }
  } catch { /* ignore */ }
  R.print_compatible_printers = Array.isArray(proc.compatible_printers) ? [...proc.compatible_printers] : [spec.machine]
  for (const k of Object.keys(R)) if (!(k in skeleton)) delete R[k]
  R.different_settings_to_system = ['', '', '']
  for (const [k, v] of Object.entries(R)) {
    const sk = skeleton[k]
    if (Array.isArray(sk) && !Array.isArray(v)) R[k] = v === '' && sk.length === 0 ? [] : [v]
    else if (!Array.isArray(sk) && Array.isArray(v)) R[k] = v.length ? v[0] : ''
  }
  for (const k of ['filament_colour', 'filament_type', 'nozzle_temperature', 'nozzle_temperature_initial_layer']) {
    if (k in R && !Array.isArray(R[k])) R[k] = [R[k]]
  }
  // Chaves por-extrusora (ex.: nozzle_volume_type) devem acompanhar o nº de
  // toolheads da máquina (nozzle_diameter). O Flash Studio dá SIGSEGV quando
  // nozzle_volume_type é menor. Usa default_nozzle_volume_type (que o perfil
  // oficial Creator 5 declara com N "Standard") como fonte de verdade.
  const nozArr = Array.isArray(R.nozzle_diameter) ? R.nozzle_diameter : []
  const nExtruders = nozArr.length
  if (nExtruders > 1) {
    for (const k of ['nozzle_volume_type']) {
      const cur = R[k]
      if (!Array.isArray(cur) || cur.length === nExtruders) continue
      const def = R['default_' + k]
      if (Array.isArray(def) && def.length === nExtruders) R[k] = [...def]
      else {
        const fallback = Array.isArray(def) && def.length ? def[0] : (cur.length ? cur[0] : 'Standard')
        R[k] = Array(nExtruders).fill(fallback)
      }
    }
  }
  return R
}

function processTable(idx, machine) {
  const out = {}
  for (const [key, j] of idx.entries()) {
    const [kind, name] = key.split('::')
    if (kind !== 'process' || j.instantiation !== 'true') continue
    const compats = j.compatible_printers ?? []
    if (!compats.includes(machine)) continue
    const r = resolveInherits(idx, 'process', name)
    const lh = Number.parseFloat(r.layer_height)
    if (!Number.isFinite(lh)) continue
    const lhR = Math.round(lh * 100) / 100
    out[String(lhR)] = { name, speeds: Object.fromEntries(SPEED_KEYS.filter(k => k in r).map(k => [k, String(r[k])])) }
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0])))
}

function filamentTable(idx, machine, wanted) {
  const out = {}
  for (const [ftype, name] of Object.entries(wanted)) {
    const j = idx.get('filament::' + name)
    const ok = !!j && (!j.compatible_printers || j.compatible_printers.includes(machine))
    out[ftype] = { name, compativel: ok }
  }
  return out
}

function main() {
  const args = process.argv.slice(2)
  const opts = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--profiles') opts.profiles = args[++i]
    else if (a === '--source-label') opts.sourceLabel = args[++i]
    else if (a === '--skeleton') opts.skeleton = args[++i]
    else if (a === '--out') opts.out = args[++i]
    else if (a === '--targets') opts.targets = args[++i].split(',')
  }
  if (!opts.profiles) {
    console.error('Uso: build-templates.mjs --profiles <pasta Flashforge> [--source-label <rótulo>] [--targets creator5,creator5pro]')
    process.exit(2)
  }
  const here = path.dirname(url.fileURLToPath(import.meta.url))
  const skeletonPath = opts.skeleton ?? path.join(here, '..', 'src', 'data', 'printers', 'ad5x', 'template.json')
  const out = opts.out ?? path.join(here, '..', 'src', 'data', 'printers')
  const sourceLabel = opts.sourceLabel ?? 'Flash Studio Desktop (vendor Flashforge Windows)'
  const targets = opts.targets ?? Object.keys(TARGETS)
  const roots = [opts.profiles]
  const parent = path.dirname(opts.profiles.replace(/[\\/]+$/, ''))
  const fallback = path.join(parent, 'OrcaFilamentLibrary')
  if (fs.existsSync(fallback)) roots.push(fallback)
  const idx = indexProfiles(roots)
  const skeleton = JSON.parse(fs.readFileSync(skeletonPath, 'utf-8'))
  for (const pid of targets) {
    const spec = TARGETS[pid]
    if (!spec) { console.error('alvo desconhecido:', pid); continue }
    const R = build(idx, spec, skeleton)
    const d = path.join(out, pid)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'template.json'), JSON.stringify(sortKeys(R), null, 4) + '\n', 'utf-8')
    const mach = resolveInherits(idx, 'machine', spec.machine)
    const mg = Object.fromEntries(GCODE_KEYS.filter(k => k in mach).map(k => [k, mach[k]]))
    const presets = {
      _origem: 'gerado por modules/extruvo-converter/scripts/build-templates.mjs a partir dos perfis Flashforge (AGPL-3.0)',
      profile_source: sourceLabel,
      machine_gcode_source: sourceLabel,
      machine: spec.machine,
      machine_gcode: mg,
      process_presets: processTable(idx, spec.machine),
      filament_presets: filamentTable(idx, spec.machine, spec.filaments),
    }
    fs.writeFileSync(path.join(d, 'presets.generated.json'), JSON.stringify(presets, null, 2) + '\n', 'utf-8')
    const skelKeys = new Set(Object.keys(skeleton))
    const types = {}
    for (const [ftype, ent] of Object.entries(presets.filament_presets)) {
      const r = resolveInherits(idx, 'filament', ent.name)
      const vals = {}
      for (const [k, v] of Object.entries(r)) {
        if (META.has(k) || ['name', 'inherits', 'from'].includes(k) || !skelKeys.has(k)) continue
        if (Array.isArray(skeleton[k])) {
          vals[k] = Array.isArray(v) && v.length ? v[0] : (Array.isArray(v) ? '' : v)
        }
      }
      types[ftype] = { preset: ent.name, values: vals }
    }
    fs.writeFileSync(path.join(d, 'filaments.generated.json'), JSON.stringify({
      _origem: 'valores resolvidos dos perfis de filamento Flashforge (AGPL-3.0)',
      profile_source: sourceLabel,
      types,
    }, null, 1) + '\n', 'utf-8')
    console.log('ok', pid, Object.keys(R).length, 'chaves', '| processos:', Object.keys(presets.process_presets).join(','))
  }
}

function sortKeys(obj) {
  if (Array.isArray(obj)) return obj
  const out = {}
  for (const k of Object.keys(obj).sort()) out[k] = obj[k]
  return out
}

main()
