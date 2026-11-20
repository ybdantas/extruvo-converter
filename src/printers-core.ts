// Núcleo compartilhado da impressora: classe `Printer`, tipos e construção
// de aliases a partir de uma lista de metadados. NÃO importa nenhum dado
// estático de impressora — pode ser consumido pelo worker em lazy-load sem
// puxar os ~5 MB de perfis Flashforge/Creality para o bundle.

export type Limits = {
  nozzle_max_c: number
  bed_max_c: number
  max_speed_mm_s: number
  max_accel_mm_s2: number
  chamber_max_c?: number
  [k: string]: unknown
}

export type PrinterMeta = {
  id: string
  label: string
  printer_model: string
  printer_settings_id: string
  template_origin?: string
  trust?: string
  filament_slots?: number
  slot_system?: string
  multi_material?: boolean
  nozzle_diameter?: number
  nozzle_count?: number
  template?: string
  limits: Limits
  bed_type?: string
  process_presets: Record<string, string>
  layer_speeds?: Record<string, Record<string, string>>
  pin_base_layer_height?: string
  filament_presets: Record<string, string>
  // Mapeamento opcional "Generic <TYPE> -> preset Generic @<impressora>".
  // Quando o filamento de origem tem `filament_vendor = "Generic"`, o motor
  // usa este preset no lugar do vendor específico (fidelidade à intenção do
  // autor; igual à receita observada no ForgeBridge).
  filament_presets_generic?: Record<string, string>
  // ID interno aplicado a `filament_ids` quando o Generic é usado.
  filament_generic_id?: string
  // Diâmetro físico do filamento aceito pela impressora (mm). Usado como
  // guarda de tempo de execução: o motor força `filament_diameter` do 3MF
  // de saída para este valor independente do template, evitando regressão
  // (ex.: bug Creator 5 / 5 Pro 2.85 -> 1.75 em 2026-11-20).
  filament_diameter_mm?: number
  filament_fallback_type?: string
  enabled?: boolean
  // true quando o fatiador alvo aceita `support_style = tree_organic` sem
  // SIGSEGV/erro. Para esses destinos o motor PRESERVA o valor em vez de
  // reescrever para `default`. Flashforge Creator 5 / 5 Pro: comprovado em
  // Flash Studio 1.7.21 (box 2026-11-16, 3×3 slice, exit 0, saída idêntica
  // à `default`). Em AD5X / Adventurer 5M / 5M Pro não há evidência atual;
  // mantemos o rewrite conservador por padrão.
  support_tree_organic_accepted?: boolean
}

export type ProjectSettings = Record<string, unknown>
export type PresetsFile = { machine_gcode?: Record<string, string>; profile_source?: string; machine_gcode_source?: string } & Record<string, unknown>
export type FilamentsFile = { types: Record<string, { values: Record<string, unknown> }> } & Record<string, unknown>

export class Printer {
  readonly id: string
  readonly label: string
  readonly slots: number
  readonly limits: Limits
  constructor(
    readonly meta: PrinterMeta,
    private readonly templateData: ProjectSettings,
    readonly presets: PresetsFile | null,
    private readonly filamentsData: FilamentsFile | null,
  ) {
    this.id = meta.id
    this.label = meta.label
    this.limits = meta.limits
    this.slots = Number(meta.filament_slots ?? 1)
  }

  get template(): ProjectSettings {
    return structuredClone(this.templateData)
  }

  get filamentValues(): Record<string, Record<string, unknown>> {
    if (!this.filamentsData) return {}
    const out: Record<string, Record<string, unknown>> = {}
    for (const [k, v] of Object.entries(this.filamentsData.types)) out[k] = v.values
    return out
  }

  public(): Record<string, unknown> {
    const m = this.meta
    const limits: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(m.limits)) if (!k.startsWith('_')) limits[k] = v
    return {
      id: this.id, label: this.label, printer_model: m.printer_model, trust: m.trust,
      filament_slots: this.slots, slot_system: m.slot_system, bed_type: m.bed_type,
      nozzle_count: m.nozzle_count ?? 1,
      limits, process_presets: m.process_presets, filament_presets: m.filament_presets,
    }
  }
}

export function normalizeAliasKey(input: string): string {
  return (input ?? '').trim().toLowerCase().replace(/[\s_\-()[\]./]/g, '')
}

export type PrinterAliasHint = {
  id: string
  printer_model?: string
  printer_settings_id?: string
  nozzle_diameter?: number
  slot_system?: string
}

// Reproduz a construção de aliases Creality (modelo + bico + CFS) e aliases manuais
// Flashforge. Alimentado por hints leves — não exige o objeto completo da impressora.
export function buildAliases(hints: PrinterAliasHint[], extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = { ...extra }
  const register = (s: string, id: string) => {
    const k = normalizeAliasKey(s)
    if (k && !out[k]) out[k] = id
  }
  for (const hint of hints) {
    const id = hint.id
    const printerModel = String(hint.printer_model || '')
    const nozzle = Number(hint.nozzle_diameter ?? 0)
    const settingsId = String(hint.printer_settings_id || '')
    const isCfs = /CFS/.test(String(hint.slot_system || ''))
    register(id, id)
    if (settingsId) register(settingsId, id)
    if (printerModel && nozzle) {
      register(`${printerModel} ${nozzle}`, id)
      register(`${printerModel} ${nozzle} nozzle`, id)
      register(`${printerModel} (${nozzle} nozzle)`, id)
    }
    if (nozzle === 0.4 && printerModel) {
      const bare = printerModel.replace(/_CFS-C$/, isCfs ? ' CFS' : '')
      register(bare, id)
      register(bare.replace(/^Creality\s+/i, ''), id)
    }
  }
  return out
}

export const FLASHFORGE_ALIASES: Record<string, string> = {
  ad5x: 'ad5x', flashforgead5x: 'ad5x',
  '5m': 'adventurer5m', ad5m: 'adventurer5m', adventurer5m: 'adventurer5m',
  '5mpro': 'adventurer5mpro', ad5mpro: 'adventurer5mpro', adventurer5mpro: 'adventurer5mpro',
  c5: 'creator5', creator5: 'creator5', flashforgecreator5: 'creator5',
  c5pro: 'creator5pro', c5p: 'creator5pro', creator5pro: 'creator5pro', flashforgecreator5pro: 'creator5pro',
}
