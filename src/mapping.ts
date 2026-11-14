// Porta de convert/flashforge/mapping.py (v0.2.3).
import mappingData from './data/bambu_to_orca.json'

export type RawMapping = typeof mappingData
export type ProjectSettings = Record<string, unknown>

export class Mapping {
  readonly raw: RawMapping
  readonly printOpts: Set<string>
  readonly filamentOpts: Set<string>
  readonly printerOpts: Set<string>
  readonly rename: Record<string, string>
  readonly carryAnyway: Set<string>
  readonly extraProcess: Set<string>
  readonly discarded: Set<string>
  readonly replaced: Set<string>
  readonly ids: Set<string>
  readonly handled: Set<string>
  readonly motionRe: RegExp
  readonly motionKeys: Set<string>
  readonly notMotion: Set<string>
  readonly tempKeys: readonly string[]
  readonly bedRe: RegExp
  readonly filamentKeep: Set<string>
  readonly keepAuthorShape: Set<string>
  readonly ranges: Record<string, [number | null, number | null]>
  readonly fixDefault: Record<string, string>
  readonly perFeatureFilamentKeys: readonly string[]
  readonly perFilamentExtra: Set<string>
  readonly valueRewrites: Record<string, Record<string, string>>

  constructor(data: RawMapping) {
    this.raw = data
    this.printOpts = new Set(data.print_options)
    this.filamentOpts = new Set(data.filament_options)
    this.printerOpts = new Set(data.printer_options)
    this.rename = { ...data.rename }
    this.carryAnyway = new Set(data.carry_anyway)
    this.extraProcess = new Set(data.extra_process)
    this.discarded = new Set(data.machine_owned_or_discarded)
    this.replaced = new Set(data.replaced_by_preset)
    this.ids = new Set(data.ids)
    this.handled = new Set(data.handled_explicitly)
    this.motionRe = new RegExp(data.motion.suffix_regex)
    this.motionKeys = new Set(data.motion.keys)
    this.notMotion = new Set(data.motion.not_motion)
    this.tempKeys = data.temperature_keys
    this.bedRe = new RegExp(data.bed_temperature_regex)
    this.filamentKeep = new Set(data.filament_keep)
    this.keepAuthorShape = new Set(data.keep_author_shape)
    this.ranges = data.ranges as unknown as Record<string, [number | null, number | null]>
    this.fixDefault = data.fix_default as unknown as Record<string, string>
    this.perFeatureFilamentKeys = data.per_feature_filament_keys
    this.perFilamentExtra = new Set(data.per_filament_extra)
    this.valueRewrites = (data.value_rewrites ?? {}) as Record<string, Record<string, string>>
  }

  targetKey(key: string): string {
    return this.rename[key] ?? key
  }

  isMotion(tk: string): boolean {
    return this.printOpts.has(tk) && !this.notMotion.has(tk)
      && (this.motionKeys.has(tk) || this.motionRe.test(tk))
  }

  classify(key: string, template: ProjectSettings, keepSpeeds = false, slowKeep: Set<string> | Record<string, unknown> = new Set()): [string, string] {
    const tk = this.targetKey(key)
    if (this.handled.has(key)) return ['handled', tk]
    if (!(tk in template)) return ['no_target', tk]
    const motion = this.isMotion(tk)
    const inSlow = slowKeep instanceof Set ? slowKeep.has(tk) : tk in slowKeep
    const carryMotion = motion && (keepSpeeds || inSlow)
    if (this.ids.has(key) || this.ids.has(tk)) return ['ids', tk]
    if (this.replaced.has(key) || this.replaced.has(tk)) return ['replaced', tk]
    if ((this.discarded.has(key) || this.discarded.has(tk)) && !carryMotion && !this.carryAnyway.has(tk)) {
      return [motion ? 'motion' : 'machine', tk]
    }
    if (this.printerOpts.has(tk) && !this.carryAnyway.has(tk)) return ['machine', tk]
    if (this.filamentOpts.has(tk) && !this.filamentKeep.has(tk) && !this.bedRe.test(tk)) return ['replaced', tk]
    if (motion && !carryMotion) return ['motion', tk]
    return ['keep', tk]
  }
}

let cached: Mapping | null = null
export function loadMapping(): Mapping {
  if (!cached) cached = new Mapping(mappingData as unknown as RawMapping)
  return cached
}
