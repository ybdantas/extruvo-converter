/// <reference lib="webworker" />
// Entrypoint do worker standalone com lazy-load: o bundle (esbuild) só traz o
// motor + JSZip. O índice de impressoras (`converter-index.js`) e o chunk da
// impressora selecionada (`chunks/<id>.js`) são carregados via `import()`
// dinâmico a partir de URLs relativas a `self.location`. Isso mantém o worker
// com ~ centenas de KB em vez dos ~5 MB anteriores e só puxa ~50 KB por
// impressora quando a conversão ocorre.
import { convertFile, ConversionError, Printer } from './engine-core'
import {
  buildAliases,
  FLASHFORGE_ALIASES,
  normalizeAliasKey,
  type FilamentsFile,
  type PresetsFile,
  type PrinterAliasHint,
  type PrinterMeta,
  type ProjectSettings,
} from './printers-core'
import type {
  ConverterPrinterId,
  PrinterInfo,
  WorkerRequest,
  WorkerResponse,
} from './protocol'

type IndexEntry = {
  id: string
  label: string
  slots: number
  bed_type?: string
  nozzle_count: number
  slot_system?: string
  printer_model?: string
  printer_settings_id?: string
  nozzle_diameter?: number
  enabled?: boolean
}

type ConverterIndex = {
  schema: string
  printers: IndexEntry[]
}

type ChunkPayload = {
  meta: PrinterMeta
  template: ProjectSettings
  presets: PresetsFile | null
  filaments: FilamentsFile | null
}

class ChunkLoadError extends Error {
  readonly code: string
  constructor(message: string, code = 'chunk_load_failed') {
    super(message)
    this.name = 'ChunkLoadError'
    this.code = code
  }
}

let indexPromise: Promise<ConverterIndex> | null = null
let aliasesPromise: Promise<Record<string, string>> | null = null
const printerCache = new Map<string, Promise<Printer>>()

function workerBase(): URL {
  const loc = (self as unknown as { location: { href: string } }).location
  return new URL('./', loc.href)
}

async function loadIndex(): Promise<ConverterIndex> {
  if (!indexPromise) {
    indexPromise = (async () => {
      const url = new URL('./converter-index.js', workerBase()).toString()
      try {
        const mod = await import(/* @vite-ignore */ url)
        const idx = (mod?.default ?? mod) as ConverterIndex
        if (!idx || !Array.isArray(idx.printers)) {
          throw new ChunkLoadError('Índice de impressoras inválido.', 'index_invalid')
        }
        return idx
      } catch (err) {
        if (err instanceof ChunkLoadError) throw err
        throw new ChunkLoadError(`Não foi possível carregar o índice de impressoras (${url}): ${(err as Error).message}`, 'index_load_failed')
      }
    })()
  }
  return indexPromise
}

async function loadAliases(): Promise<Record<string, string>> {
  if (!aliasesPromise) {
    aliasesPromise = loadIndex().then(idx => {
      const hints: PrinterAliasHint[] = idx.printers
        .filter(p => p.enabled !== false)
        .map(p => ({
          id: p.id,
          printer_model: p.printer_model,
          printer_settings_id: p.printer_settings_id,
          nozzle_diameter: p.nozzle_diameter,
          slot_system: p.slot_system,
        }))
      return buildAliases(hints, FLASHFORGE_ALIASES)
    })
  }
  return aliasesPromise
}

async function resolvePrinterId(raw: string): Promise<string> {
  const aliases = await loadAliases()
  const key = normalizeAliasKey(raw ?? '')
  return aliases[key] ?? key
}

async function loadPrinter(rawId: string): Promise<Printer> {
  const id = await resolvePrinterId(rawId)
  let entry = printerCache.get(id)
  if (!entry) {
    entry = (async () => {
      const idx = await loadIndex()
      if (!idx.printers.some(p => p.id === id && p.enabled !== false)) {
        throw new ChunkLoadError(`Impressora desconhecida: ${rawId}`, 'unknown_printer')
      }
      const url = new URL(`./chunks/${encodeURIComponent(id)}.js`, workerBase()).toString()
      let payload: ChunkPayload
      try {
        const mod = await import(/* @vite-ignore */ url)
        payload = (mod?.default ?? mod) as ChunkPayload
      } catch (err) {
        throw new ChunkLoadError(
          `Perfil da impressora ${id} indisponível (${url}): ${(err as Error).message}`,
          'chunk_load_failed',
        )
      }
      if (!payload || !payload.meta || !payload.template) {
        throw new ChunkLoadError(`Chunk da impressora ${id} está corrompido.`, 'chunk_invalid')
      }
      return new Printer(payload.meta, payload.template, payload.presets ?? null, payload.filaments ?? null)
    })()
    printerCache.set(id, entry)
  }
  try {
    return await entry
  } catch (err) {
    // Não cache um erro — permite novas tentativas (ex.: queda transitória de rede).
    printerCache.delete(id)
    throw err
  }
}

async function buildPrinterList(): Promise<PrinterInfo[]> {
  const idx = await loadIndex()
  return idx.printers
    .filter(p => p.enabled !== false)
    .map(p => ({
      id: p.id as ConverterPrinterId,
      label: p.label,
      slots: p.slots,
      bed_type: p.bed_type,
      nozzle_count: Number(p.nozzle_count ?? 1),
      slot_system: p.slot_system,
    }))
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data
  const id = req.id
  try {
    if (req.type === 'list_printers') {
      const response: WorkerResponse = { type: 'printers', id, list: await buildPrinterList() }
      ;(self as unknown as { postMessage: (m: unknown) => void }).postMessage(response)
      return
    }
    if (req.type === 'convert') {
      const bytes = req.input instanceof Uint8Array ? req.input : new Uint8Array(req.input)
      const printer = await loadPrinter(req.options.printer_id)
      const { output, report } = await convertFile(bytes, printer, {
        keep_speeds: !!req.options.keep_speeds,
        prune_unused: req.options.prune_unused !== false,
        single_filament: !!req.options.single_filament,
        src_name: req.options.src_name,
      })
      const response: WorkerResponse = {
        type: 'result',
        id,
        result: {
          output,
          report,
          status: report.status,
          warnings: report.warnings,
          pending: report.pending,
          printer_id: req.options.printer_id,
        },
      }
      ;(self as unknown as { postMessage: (m: unknown, t?: unknown[]) => void }).postMessage(response, [output.buffer])
      return
    }
    const bad: WorkerResponse = { type: 'error', id, message: 'Mensagem desconhecida', code: 'bad_request' }
    ;(self as unknown as { postMessage: (m: unknown) => void }).postMessage(bad)
  } catch (error) {
    let response: WorkerResponse
    if (error instanceof ConversionError) {
      response = { type: 'error', id, message: error.message, code: error.code, report: error.report }
    } else if (error instanceof ChunkLoadError) {
      response = { type: 'error', id, message: error.message, code: error.code }
    } else {
      response = { type: 'error', id, message: error instanceof Error ? error.message : 'Falha na conversão.', code: 'unexpected_error' }
    }
    ;(self as unknown as { postMessage: (m: unknown) => void }).postMessage(response)
  }
}
