// Registro estático de impressoras Flashforge + Creality. Puxa TODOS os perfis
// via import JSON — ~5 MB — e é usado apenas no caminho de testes Node e no
// wrapper `engine.ts`. O worker standalone NÃO importa este arquivo: ele usa
// `printers-core.ts` + chunks carregados sob demanda a partir do disco/HTTP.
import ad5xMeta from './data/printers/ad5x/printer.json'
import ad5xTemplate from './data/printers/ad5x/template.json'
import ad5xPresets from './data/printers/ad5x/presets.generated.json'
import ad5xFilaments from './data/printers/ad5x/filaments.generated.json'
import a5mMeta from './data/printers/adventurer5m/printer.json'
import a5mTemplate from './data/printers/adventurer5m/template.json'
import a5mPresets from './data/printers/adventurer5m/presets.generated.json'
import a5mFilaments from './data/printers/adventurer5m/filaments.generated.json'
import a5mpMeta from './data/printers/adventurer5mpro/printer.json'
import a5mpTemplate from './data/printers/adventurer5mpro/template.json'
import a5mpPresets from './data/printers/adventurer5mpro/presets.generated.json'
import a5mpFilaments from './data/printers/adventurer5mpro/filaments.generated.json'
import c5Meta from './data/printers/creator5/printer.json'
import c5Template from './data/printers/creator5/template.json'
import c5Presets from './data/printers/creator5/presets.generated.json'
import c5Filaments from './data/printers/creator5/filaments.generated.json'
import c5pMeta from './data/printers/creator5pro/printer.json'
import c5pTemplate from './data/printers/creator5pro/template.json'
import c5pPresets from './data/printers/creator5pro/presets.generated.json'
import c5pFilaments from './data/printers/creator5pro/filaments.generated.json'
import { CREALITY_PRINTERS, CREALITY_ORIGIN } from './data/printers/creality/index.generated'
import {
  Printer,
  buildAliases,
  FLASHFORGE_ALIASES,
  normalizeAliasKey,
  type FilamentsFile,
  type PresetsFile,
  type PrinterAliasHint,
  type PrinterMeta,
  type ProjectSettings,
} from './printers-core'

export {
  Printer,
  type Limits,
  type PrinterMeta,
  type ProjectSettings,
  type PresetsFile,
  type FilamentsFile,
} from './printers-core'

const PRINTERS: Printer[] = [
  new Printer(ad5xMeta as unknown as PrinterMeta, ad5xTemplate as ProjectSettings, ad5xPresets as unknown as PresetsFile, ad5xFilaments as unknown as FilamentsFile),
  new Printer(a5mMeta as unknown as PrinterMeta, a5mTemplate as ProjectSettings, a5mPresets as unknown as PresetsFile, a5mFilaments as unknown as FilamentsFile),
  new Printer(a5mpMeta as unknown as PrinterMeta, a5mpTemplate as ProjectSettings, a5mpPresets as unknown as PresetsFile, a5mpFilaments as unknown as FilamentsFile),
  new Printer(c5Meta as unknown as PrinterMeta, c5Template as ProjectSettings, c5Presets as unknown as PresetsFile, c5Filaments as unknown as FilamentsFile),
  new Printer(c5pMeta as unknown as PrinterMeta, c5pTemplate as ProjectSettings, c5pPresets as unknown as PresetsFile, c5pFilaments as unknown as FilamentsFile),
  ...CREALITY_PRINTERS.map(e => new Printer(
    e.meta as unknown as PrinterMeta,
    e.template as ProjectSettings,
    e.presets as unknown as PresetsFile,
    e.filaments as unknown as FilamentsFile,
  )),
]

export const CREALITY_PROFILES_ORIGIN = CREALITY_ORIGIN

export function listPrinters(): Printer[] {
  return PRINTERS.filter(p => p.meta.enabled !== false)
}

const ALIASES: Record<string, string> = buildAliases(
  PRINTERS.map((p): PrinterAliasHint => ({
    id: p.id,
    printer_model: p.meta.printer_model,
    printer_settings_id: p.meta.printer_settings_id,
    nozzle_diameter: p.meta.nozzle_diameter,
    slot_system: p.meta.slot_system,
  })),
  FLASHFORGE_ALIASES,
)

export function getPrinter(pid: string): Printer {
  const key = normalizeAliasKey(pid ?? '')
  const id = ALIASES[key] ?? key
  const found = listPrinters().find(p => p.id === id)
  if (!found) throw new Error(`Impressora desconhecida: ${pid}`)
  return found
}
