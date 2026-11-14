#!/usr/bin/env node
// Gera templates para todas as impressoras Creality do snapshot pinado dos perfis
// oficiais do OrcaSlicer (resources/profiles/Creality*). Usa o mesmo algoritmo de
// herança do build-templates.mjs (processo -> filamento -> máquina) e filtra pela
// skeleton do AD5X para manter o conjunto de chaves esperado pelo motor.
//
// Uso:
//   node modules/extruvo-converter/scripts/build-creality.mjs \
//     --profiles modules/extruvo-converter/vendor/orca-creality/<hash>/Creality \
//     --hash <hash> \
//     [--out modules/extruvo-converter/src/data/printers/creality] \
//     [--only "Creality K1 Max"]  # subcadeia opcional p/ filtrar modelos
//
// Importante: os perfis Creality são AGPL-3.0 (OrcaSlicer). O JSON gerado é
// derivado dos perfis oficiais do commit pinado (ver NOTICE).

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import url from 'node:url'

const META = new Set([
  'type', 'instantiation', 'setting_id', 'description', 'renamed_from', 'compatible_printers',
  'compatible_printers_condition', 'compatible_prints', 'compatible_prints_condition', 'filament_id',
  'base_id',
])
const SPEED_KEYS = ['sparse_infill_speed', 'internal_solid_infill_speed', 'gap_infill_speed']
const GCODE_KEYS = [
  'machine_start_gcode', 'machine_end_gcode', 'before_layer_change_gcode', 'layer_change_gcode',
  'change_filament_gcode', 'machine_pause_gcode', 'template_custom_gcode', 'file_start_gcode',
  'time_lapse_gcode', 'change_extrusion_role_gcode', 'printing_by_object_gcode', 'filename_format',
]

// Tipos de filamento comuns que tentaremos mapear. Para cada tipo escolhemos o preset
// oficial do OrcaSlicer que for compatível com a máquina. Ordem de preferência: nome
// contém o próprio modelo -> vendor Creality -> primeiro Generic do tipo.
const FILAMENT_TYPES = ['PLA', 'PLA-CF', 'PETG', 'PETG-CF', 'ABS', 'ASA', 'TPU', 'PC', 'PA-CF', 'PA']

function indexProfiles(root) {
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
  walk(root, '')
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

function sortKeys(obj) {
  if (Array.isArray(obj)) return obj
  const out = {}
  for (const k of Object.keys(obj).sort()) out[k] = obj[k]
  return out
}

function slug(name) {
  return String(name)
    .toLowerCase()
    .replace(/^creality\s+/, '')
    .replace(/_cfs-c/g, '-cfs')
    .replace(/[()]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function discoverMachineModels(idx) {
  // retorna lista {modelName, machineProfiles:[{name, nozzle}]}
  const models = new Map()
  for (const [k, j] of idx.entries()) {
    if (!k.startsWith('machine::')) continue
    if (/^fdm_/.test(j.name)) continue
    // é um modelo (sem nozzle) ou uma variante (com nozzle)
    const m1 = j.name.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s+nozzle$/)
    const m2 = j.name.match(/^(.+?)\s+\((\d+(?:\.\d+)?)\s+nozzle\)$/)
    const m = m1 || m2
    if (m) {
      const [, modelName, nozzle] = m
      if (!models.has(modelName)) models.set(modelName, { modelName, machineProfiles: [] })
      models.get(modelName).machineProfiles.push({ name: j.name, nozzle })
    }
  }
  // garante que todos os modelos têm um descritor (sem nozzle) no índice
  for (const [name] of models) {
    if (!idx.has('machine::' + name)) {
      console.warn('[warn] modelo sem descritor base:', name)
    }
  }
  return [...models.values()].sort((a, b) => a.modelName.localeCompare(b.modelName))
}

function normalizePolygonFields(obj) {
  // Alguns perfis Creality trazem "printable_area" como string única com
  // vírgulas em vez do array ["0x0","300x0",...]. Normaliza para o formato
  // que o motor espera.
  for (const k of ['printable_area', 'bed_exclude_area']) {
    const v = obj[k]
    if (typeof v === 'string' && /,/.test(v)) obj[k] = v.split(',').map(s => s.trim()).filter(Boolean)
  }
  return obj
}

function buildTemplate(idx, machineName, processName, filamentName, skeleton) {
  const proc = resolveInherits(idx, 'process', processName)
  const fil = resolveInherits(idx, 'filament', filamentName)
  const mach = normalizePolygonFields(resolveInherits(idx, 'machine', machineName))
  const R = {}
  for (const [k, v] of Object.entries(skeleton)) R[k] = structuredClone(v)
  for (const src of [proc, fil, mach]) {
    for (const [k, v] of Object.entries(src)) {
      if (META.has(k) || k === 'name' || k === 'inherits' || k === 'from') continue
      R[k] = structuredClone(v)
    }
  }
  R.default_filament_profile = [filamentName]
  R.print_settings_id = processName
  R.printer_settings_id = machineName
  R.filament_settings_id = [filamentName]
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
  R.print_compatible_printers = Array.isArray(proc.compatible_printers) ? [...proc.compatible_printers] : [machineName]
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
  // Orca 2.5 rejeita retraction_distances_when_cut fora de [10, 18] (exit 238).
  // Perfil oficial Creality K2 0.4 = 30, SPARKX i7 todos = 28, Sermoon M300 0.4 = 30:
  // grava 18 (valor válido e já usado pelas irmãs 0.6/0.8 do mesmo perfil).
  // Divergência documentada no NOTICE.
  const clampRetr = (val) => {
    const parts = String(val).split(',').map(s => s.trim())
    const out = parts.map(p => {
      const n = Number(p)
      if (!Number.isFinite(n)) return p
      return n < 10 ? '10' : (n > 18 ? '18' : p)
    })
    return out.join(',')
  }
  if ('retraction_distances_when_cut' in R) {
    const rv = R.retraction_distances_when_cut
    R.retraction_distances_when_cut = Array.isArray(rv) ? rv.map(clampRetr) : clampRetr(rv)
  }
  return R
}

function processTable(idx, machineName) {
  const out = {}
  for (const [key, j] of idx.entries()) {
    if (!key.startsWith('process::') || j.instantiation !== 'true') continue
    const compats = j.compatible_printers ?? []
    if (!compats.includes(machineName)) continue
    const r = resolveInherits(idx, 'process', j.name)
    const lh = Number.parseFloat(r.layer_height)
    if (!Number.isFinite(lh)) continue
    const lhR = Math.round(lh * 100) / 100
    // várias processes podem ter a mesma altura; preferimos a de "Standard" se houver
    const prev = out[String(lhR)]
    const score = /\bstandard\b/i.test(j.name) ? 2 : (/\bdraft\b/i.test(j.name) ? 1 : 0)
    if (!prev || prev.score < score) {
      out[String(lhR)] = { name: j.name, score, speeds: Object.fromEntries(SPEED_KEYS.filter(k => k in r).map(k => [k, String(r[k])])) }
    }
  }
  const sorted = Object.fromEntries(Object.entries(out).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0])))
  // remove campo score
  const clean = {}
  for (const [k, v] of Object.entries(sorted)) clean[k] = { name: v.name, speeds: v.speeds }
  return clean
}

// Para cada tipo, encontrar o melhor preset compatível com a máquina.
function pickFilamentForType(idx, machineName, machineModelName, type) {
  const candidates = []
  for (const [key, j] of idx.entries()) {
    if (!key.startsWith('filament::') || j.instantiation !== 'true') continue
    const compats = j.compatible_printers ?? []
    if (!compats.includes(machineName)) continue
    const resolved = resolveInherits(idx, 'filament', j.name)
    const ft = Array.isArray(resolved.filament_type) ? resolved.filament_type[0] : resolved.filament_type
    if (!ft) continue
    if (String(ft).toUpperCase() !== type.toUpperCase()) continue
    // detectar PLA-CF etc pelo nome
    const upperName = j.name.toUpperCase()
    if (type === 'PLA' && /\b(PLA[- ]?CF|PLA[- ]?HF|PLA[- ]?HIGH|PLA[- ]?SILK|PLA[- ]?MATTE)\b/i.test(j.name)) continue
    if (type === 'PLA-CF' && !/(PLA[- ]?CF)/i.test(j.name)) continue
    if (type === 'PETG-CF' && !/(PETG[- ]?CF)/i.test(j.name)) continue
    candidates.push(j.name)
    void upperName
  }
  if (!candidates.length) return null
  const modelLower = machineModelName.toLowerCase()
  // ordenar preferindo: contém modelo -> contém 'Creality' -> Generic -> primeiro
  candidates.sort((a, b) => {
    const score = s => {
      let r = 0
      if (s.toLowerCase().includes(modelLower)) r += 4
      if (/@creality/i.test(s)) r += 2
      if (/^generic /i.test(s)) r += 1
      return -r
    }
    return score(a) - score(b) || a.localeCompare(b)
  })
  return candidates[0]
}

function filamentTable(idx, machineName, machineModelName) {
  const out = {}
  for (const t of FILAMENT_TYPES) {
    const name = pickFilamentForType(idx, machineName, machineModelName, t)
    if (name) out[t] = { name, compativel: true }
  }
  return out
}

function deriveLimits(idx, machineName, resolvedMachine) {
  // nozzle_max_c: máximo nozzle_temperature_range_high entre filamentos compatíveis
  let nmax = 0
  let bmax = 0
  for (const [key, j] of idx.entries()) {
    if (!key.startsWith('filament::') || j.instantiation !== 'true') continue
    const compats = j.compatible_printers ?? []
    if (!compats.includes(machineName)) continue
    const r = resolveInherits(idx, 'filament', j.name)
    for (const nkey of ['nozzle_temperature_range_high', 'nozzle_temperature']) {
      const v = r[nkey]
      if (Array.isArray(v)) for (const x of v) { const n = Number(x); if (Number.isFinite(n) && n > nmax) nmax = n }
    }
    for (const bkey of ['hot_plate_temp', 'textured_plate_temp', 'eng_plate_temp', 'supertack_plate_temp']) {
      const v = r[bkey]
      if (Array.isArray(v)) for (const x of v) { const n = Number(x); if (Number.isFinite(n) && n > bmax) bmax = n }
    }
  }
  const sx = resolvedMachine.machine_max_speed_x
  const ax = resolvedMachine.machine_max_acceleration_x
  const speed = Array.isArray(sx) ? Math.max(...sx.map(v => Number(v) || 0)) : (Number(sx) || 0)
  const accel = Array.isArray(ax) ? Math.max(...ax.map(v => Number(v) || 0)) : (Number(ax) || 0)
  const limits = {
    nozzle_max_c: nmax || 300,
    bed_max_c: bmax || 110,
    max_speed_mm_s: speed || 500,
    max_accel_mm_s2: accel || 10000,
  }
  // câmara se o perfil declara suporte
  const supCham = resolvedMachine.support_chamber_temp_control
  if (String(Array.isArray(supCham) ? supCham[0] : supCham) === '1') limits.chamber_max_c = 60
  return limits
}

function isCfs(resolvedMachine, machineModelName) {
  // Em Creality, todas as impressoras de 1 bico herdam
  // single_extruder_multi_material: 1 do fdm_creality_common. Isso NÃO significa
  // que haja hardware CFS. CFS real = modelo com sufixo _CFS-C (variantes K1) ou
  // família K2 (CFS vem de fábrica).
  if (/_CFS-C$/.test(machineModelName)) return true
  if (/^Creality K2(\s|$)/.test(machineModelName)) return true
  void resolvedMachine
  return false
}

function pickBedType(resolvedMachine) {
  // dedupe bed_types via curr_bed_type default_print_profile / support_multi_bed_types
  const bt = resolvedMachine.curr_bed_type
  if (bt) return Array.isArray(bt) ? bt[0] : bt
  // caller falls back to High Temp Plate
  return 'High Temp Plate'
}

function processPresetsIndex(table) {
  const out = {}
  for (const [k, v] of Object.entries(table)) out[k] = v.name
  return out
}

function layerSpeedsIndex(table) {
  const out = {}
  for (const [k, v] of Object.entries(table)) out[k] = v.speeds
  return out
}

function filamentPresetsIndex(table) {
  const out = {}
  for (const [k, v] of Object.entries(table)) out[k] = v.name
  return out
}

function main() {
  const args = process.argv.slice(2)
  const opts = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--profiles') opts.profiles = args[++i]
    else if (a === '--hash') opts.hash = args[++i]
    else if (a === '--out') opts.out = args[++i]
    else if (a === '--skeleton') opts.skeleton = args[++i]
    else if (a === '--only') opts.only = args[++i]
    else if (a === '--tag') opts.tag = args[++i]
  }
  if (!opts.profiles || !opts.hash) {
    console.error('Uso: build-creality.mjs --profiles <dir> --hash <sha> [--out <dir>] [--only <substring>] [--tag <v2.5.0>]')
    process.exit(2)
  }
  const here = path.dirname(url.fileURLToPath(import.meta.url))
  const skeletonPath = opts.skeleton ?? path.join(here, '..', 'src', 'data', 'printers', 'ad5x', 'template.json')
  const outRoot = opts.out ?? path.join(here, '..', 'src', 'data', 'printers', 'creality')
  const skeleton = JSON.parse(fs.readFileSync(skeletonPath, 'utf-8'))
  const idx = indexProfiles(opts.profiles)
  const models = discoverMachineModels(idx).filter(m => !opts.only || m.modelName.includes(opts.only))
  fs.mkdirSync(outRoot, { recursive: true })

  const sourceLabel = `OrcaSlicer ${opts.tag ? opts.tag + ' ' : ''}(SoftFever/OrcaSlicer @${opts.hash}, resources/profiles/Creality*) [AGPL-3.0]`

  const registry = []
  let okCount = 0, errCount = 0
  for (const model of models) {
    for (const prof of model.machineProfiles) {
      const machineName = prof.name
      try {
        const resolvedMachine = normalizePolygonFields(resolveInherits(idx, 'machine', machineName))
        const processes = processTable(idx, machineName)
        if (!Object.keys(processes).length) {
          console.warn('[skip] sem processos para', machineName)
          continue
        }
        const filamentTypes = filamentTable(idx, machineName, model.modelName)
        if (!filamentTypes.PLA && !filamentTypes.PETG) {
          console.warn('[skip] sem PLA/PETG para', machineName)
          continue
        }
        const defaultType = filamentTypes.PLA ? 'PLA' : (filamentTypes.PETG ? 'PETG' : Object.keys(filamentTypes)[0])
        const defaultFilament = filamentTypes[defaultType].name
        const processKeys = Object.keys(processes)
        // pin na altura 0.20 se houver, senão a mais próxima disponível
        const pin = processKeys.includes('0.2') ? '0.2' : processKeys.sort((a, b) => Math.abs(parseFloat(a) - 0.2) - Math.abs(parseFloat(b) - 0.2))[0]
        const pinProcess = processes[pin].name

        const template = buildTemplate(idx, machineName, pinProcess, defaultFilament, skeleton)
        const limits = deriveLimits(idx, machineName, resolvedMachine)
        const cfs = isCfs(resolvedMachine, model.modelName)
        const nozzle = Number(prof.nozzle)
        const bedType = pickBedType(resolvedMachine)

        const idSlug = slug(machineName)  // ex: cr-10-0-4-nozzle, k1-cfs-0-4-nozzle, k1-max-0-4-nozzle
        // normaliza: se nome termina com "0-X-nozzle", reescreve para "-0-X"
        const idCompact = idSlug.replace(/-(\d+)-(\d+)-nozzle$/, '-$1$2').replace(/-(\d+)-nozzle$/, '-$1')
        const printerId = `creality-${idCompact}`

        const modelFamily = model.modelName.replace(/^Creality\s+/, '').replace(/_CFS-C$/, '')
        const slotSystem = cfs
          ? 'CFS (Creality Filament System, até 4 carretéis compartilhando 1 bico)'
          : 'monofilamento (1 bico, sem CFS)'
        const slots = cfs ? 4 : 1

        const dir = path.join(outRoot, printerId)
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'template.json'), JSON.stringify(sortKeys(template), null, 2) + '\n', 'utf-8')

        const machineGcode = Object.fromEntries(GCODE_KEYS.filter(k => k in resolvedMachine).map(k => [k, resolvedMachine[k]]))
        const presets = {
          _origem: 'gerado por modules/extruvo-converter/scripts/build-creality.mjs a partir dos perfis Creality do OrcaSlicer (AGPL-3.0)',
          profile_source: sourceLabel,
          machine_gcode_source: sourceLabel,
          machine: machineName,
          machine_gcode: machineGcode,
          process_presets: processes,
          filament_presets: filamentTypes,
        }
        fs.writeFileSync(path.join(dir, 'presets.generated.json'), JSON.stringify(presets, null, 2) + '\n', 'utf-8')

        // resolver valores de filamento por tipo (apenas chaves que estão no skeleton)
        const skelKeys = new Set(Object.keys(skeleton))
        const types = {}
        for (const [ftype, ent] of Object.entries(filamentTypes)) {
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
        fs.writeFileSync(path.join(dir, 'filaments.generated.json'), JSON.stringify({
          _origem: 'valores resolvidos dos perfis de filamento Creality do OrcaSlicer (AGPL-3.0)',
          profile_source: sourceLabel,
          types,
        }, null, 1) + '\n', 'utf-8')

        const printerJson = {
          id: printerId,
          label: `Creality ${modelFamily}${cfs ? ' (CFS)' : ''} ${nozzle.toFixed(2)} mm`,
          printer_model: resolvedMachine.printer_model ?? model.modelName,
          printer_settings_id: machineName,
          template_origin: `Gerado por modules/extruvo-converter/scripts/build-creality.mjs resolvendo a herança dos perfis oficiais do OrcaSlicer ${opts.tag ?? ''} (SoftFever/OrcaSlicer @${opts.hash}, resources/profiles/Creality/machine/${machineName}.json).`.trim(),
          trust: 'template derivado automaticamente dos perfis oficiais OrcaSlicer (commit pinado); não validado em fatiamento real nem em impressão física. Multi-material em CFS é tratado como filamentos lógicos — a atribuição física slot->filamento cabe ao Creality Print/OrcaSlicer.',
          filament_slots: slots,
          slot_system: slotSystem,
          multi_material: cfs,
          nozzle_diameter: nozzle,
          nozzle_count: 1,
          template: 'template.json',
          limits,
          bed_type: bedType,
          process_presets: processPresetsIndex(processes),
          layer_speeds: layerSpeedsIndex(processes),
          pin_base_layer_height: pin,
          filament_presets: filamentPresetsIndex(filamentTypes),
          filament_fallback_type: defaultType,
          enabled: true,
        }
        fs.writeFileSync(path.join(dir, 'printer.json'), JSON.stringify(printerJson, null, 2) + '\n', 'utf-8')

        registry.push({
          id: printerId,
          dir: printerId,
          label: printerJson.label,
          model_family: modelFamily,
          machineName,
          nozzle,
          cfs: cfs,
          slots,
          printable_area: resolvedMachine.printable_area,
          printable_height: resolvedMachine.printable_height,
        })
        okCount++
      } catch (err) {
        errCount++
        console.error('[erro]', machineName, err.message)
      }
    }
  }

  registry.sort((a, b) => a.id.localeCompare(b.id))
  const registryPath = path.join(outRoot, 'registry.generated.json')
  fs.writeFileSync(registryPath, JSON.stringify({
    _origem: 'gerado por modules/extruvo-converter/scripts/build-creality.mjs',
    profile_source: sourceLabel,
    commit: opts.hash,
    tag: opts.tag ?? null,
    count: registry.length,
    printers: registry,
  }, null, 2) + '\n', 'utf-8')

  // Gera um módulo TypeScript que importa todos os perfis Creality.
  const tsPath = path.join(outRoot, 'index.generated.ts')
  const importLines = []
  const entryLines = []
  for (const p of registry) {
    const ident = p.id.replace(/[^a-zA-Z0-9]/g, '_')
    importLines.push(`import ${ident}Meta from './${p.dir}/printer.json'`)
    importLines.push(`import ${ident}Template from './${p.dir}/template.json'`)
    importLines.push(`import ${ident}Presets from './${p.dir}/presets.generated.json'`)
    importLines.push(`import ${ident}Filaments from './${p.dir}/filaments.generated.json'`)
    entryLines.push(`  { meta: ${ident}Meta, template: ${ident}Template, presets: ${ident}Presets, filaments: ${ident}Filaments },`)
  }
  const ts = `// Gerado por modules/extruvo-converter/scripts/build-creality.mjs.
// NÃO EDITAR MANUALMENTE. Para regenerar:
//   node modules/extruvo-converter/scripts/build-creality.mjs --profiles <vendor dir> --hash <sha> --tag <tag>
//
// Fonte: OrcaSlicer ${opts.tag ?? ''} (SoftFever/OrcaSlicer @${opts.hash}, AGPL-3.0).
${importLines.join('\n')}

export type CrealityEntry = {
  meta: unknown
  template: unknown
  presets: unknown
  filaments: unknown
}

export const CREALITY_PRINTERS: CrealityEntry[] = [
${entryLines.join('\n')}
]

export const CREALITY_ORIGIN = ${JSON.stringify({
    commit: opts.hash,
    tag: opts.tag ?? null,
    profile_source: sourceLabel,
    count: registry.length,
  })} as const
`
  fs.writeFileSync(tsPath, ts, 'utf-8')

  console.log(`ok ${okCount} impressoras geradas; ${errCount} erro(s). Registry: ${registryPath}. Módulo TS: ${tsPath}`)
}

main()
