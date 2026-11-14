// Protocolo de mensagens entre o aplicativo Extruvo e o worker standalone
// `dist/converter.worker.js`. O aplicativo NÃO importa nada do motor: só
// usa estes tipos para escrever/ler mensagens.
import type { ConversionReport } from './engine'

// ID da impressora. Em v2 passamos a aceitar modelos Creality derivados do
// OrcaSlicer, cujo ID segue o padrão "creality-<modelo>-<bico>". O tipo
// permanece aberto (string) — o worker publica a lista real via `list_printers`.
export type ConverterPrinterId = 'ad5x' | 'adventurer5m' | 'adventurer5mpro' | 'creator5' | 'creator5pro' | (string & { __brand?: 'converter-printer-id' })

export type PrinterInfo = {
  id: ConverterPrinterId
  label: string
  slots: number
  bed_type?: string
  nozzle_count: number
  slot_system?: string
}

export type ListPrintersRequest = {
  type: 'list_printers'
  id?: string
}

export type ConvertRequestPayload = {
  type: 'convert'
  id?: string
  input: ArrayBuffer | Uint8Array
  options: {
    printer_id: ConverterPrinterId
    keep_speeds?: boolean
    prune_unused?: boolean
    single_filament?: boolean
    src_name?: string
  }
}

export type WorkerRequest = ListPrintersRequest | ConvertRequestPayload

export type PrintersResponse = {
  type: 'printers'
  id?: string
  list: PrinterInfo[]
}

export type ConvertResult = {
  output: Uint8Array
  report: ConversionReport
  status: string
  warnings: string[]
  pending: string[]
  printer_id: ConverterPrinterId
}

export type ResultResponse = {
  type: 'result'
  id?: string
  result: ConvertResult
}

export type ErrorResponse = {
  type: 'error'
  id?: string
  message: string
  code?: string
  report?: unknown
}

export type WorkerResponse = PrintersResponse | ResultResponse | ErrorResponse

export const CONVERTER_PROTOCOL_VERSION = 1
