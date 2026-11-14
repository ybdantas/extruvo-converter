// Compatibilidade retroativa: expõe a mesma API de antes, mas carrega o
// `Printer` via `getPrinter` (registro estático em `printers.ts`). O worker
// standalone NÃO consome este módulo — usa `engine-core.ts` + chunks lazy.
import { convertFile as coreConvert, type ConvertOptions, type ConversionReport } from './engine-core'
import { getPrinter } from './printers'

export {
  ENGINE_VERSION,
  BED_KEY_BY_TYPE,
  ConversionError,
  summary,
} from './engine-core'
export type {
  ConvertOptions,
  ConversionReport,
  Renamed,
  Discarded,
  Capped,
  SpeedRow,
  AuthorCustomised,
  FilamentRow,
  PlateRow,
} from './engine-core'

export async function convertFile(src: Uint8Array | ArrayBuffer, options: ConvertOptions = {}): Promise<{ output: Uint8Array; report: ConversionReport }> {
  const printer = getPrinter(options.printer_id ?? 'ad5x')
  return coreConvert(src, printer, options)
}
