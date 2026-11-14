#!/usr/bin/env node
// Empacota o worker standalone em LAZY-LOAD.
//
// Saídas em `modules/extruvo-converter/dist/`:
//   - converter.worker.js      — núcleo mínimo (motor + JSZip + Printer), sem
//                                nenhum template; carrega índice + chunks em
//                                tempo de execução via import() dinâmico.
//   - converter-index.js       — ESM com `export default { schema, printers }`;
//                                puxado 1× pelo worker (lista + aliases).
//   - chunks/<id>.js           — ESM com `export default { meta, template,
//                                presets, filaments }`; um chunk por impressora.
//
// Usado pelo app Extruvo via `?url`. As pastas `converter-index.js` e `chunks/`
// precisam ser copiadas para o diretório do worker emitido pelo Vite — ver
// `build/converter-chunks-vite-plugin.ts`.
import { build } from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'

const here = path.dirname(url.fileURLToPath(import.meta.url))
const moduleRoot = path.resolve(here, '..')
const dataRoot = path.join(moduleRoot, 'src', 'data', 'printers')
const distDir = path.join(moduleRoot, 'dist')
const chunksDir = path.join(distDir, 'chunks')

const BANNER = '// @extruvo/converter (AGPL-3.0). Fonte: modules/extruvo-converter/.\n// Veja NOTICE no mesmo diretório para o detalhamento das licenças.'

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf-8'))
}

async function exists(p) {
  try { await fs.access(p); return true } catch { return false }
}

async function collectPrinterDirs() {
  // Impressoras Flashforge diretas + todas as subpastas de creality/<id>.
  const roots = []
  for (const name of await fs.readdir(dataRoot)) {
    const p = path.join(dataRoot, name)
    const info = await fs.stat(p)
    if (!info.isDirectory()) continue
    if (name === 'creality') {
      for (const sub of await fs.readdir(p)) {
        const subPath = path.join(p, sub)
        const subInfo = await fs.stat(subPath)
        if (subInfo.isDirectory() && await exists(path.join(subPath, 'printer.json'))) {
          roots.push(subPath)
        }
      }
    } else if (await exists(path.join(p, 'printer.json'))) {
      roots.push(p)
    }
  }
  return roots.sort((a, b) => a.localeCompare(b))
}

async function loadPrinter(dir) {
  const [meta, template, presets, filaments] = await Promise.all([
    readJson(path.join(dir, 'printer.json')),
    readJson(path.join(dir, 'template.json')),
    (await exists(path.join(dir, 'presets.generated.json'))) ? readJson(path.join(dir, 'presets.generated.json')) : null,
    (await exists(path.join(dir, 'filaments.generated.json'))) ? readJson(path.join(dir, 'filaments.generated.json')) : null,
  ])
  return { meta, template, presets, filaments }
}

function indexEntryFromMeta(meta) {
  return {
    id: String(meta.id),
    label: String(meta.label),
    slots: Number(meta.filament_slots ?? 1),
    bed_type: meta.bed_type,
    nozzle_count: Number(meta.nozzle_count ?? 1),
    slot_system: meta.slot_system,
    printer_model: meta.printer_model,
    printer_settings_id: meta.printer_settings_id,
    nozzle_diameter: typeof meta.nozzle_diameter === 'number' ? meta.nozzle_diameter : undefined,
    enabled: meta.enabled !== false,
  }
}

async function emitChunks() {
  await fs.rm(chunksDir, { recursive: true, force: true })
  await fs.mkdir(chunksDir, { recursive: true })
  const dirs = await collectPrinterDirs()
  const indexPrinters = []
  const chunkStats = []
  for (const dir of dirs) {
    const payload = await loadPrinter(dir)
    if (payload.meta.enabled === false) continue
    const id = String(payload.meta.id)
    const json = JSON.stringify(payload)
    const body = `export default ${json}\n`
    const outPath = path.join(chunksDir, `${id}.js`)
    await fs.writeFile(outPath, body, 'utf-8')
    chunkStats.push({ id, bytes: Buffer.byteLength(body) })
    indexPrinters.push(indexEntryFromMeta(payload.meta))
  }
  indexPrinters.sort((a, b) => a.id.localeCompare(b.id))
  const index = { schema: 'extruvo-converter-index/v1', printers: indexPrinters }
  const indexBody = `${BANNER}\nexport default ${JSON.stringify(index)}\n`
  const indexPath = path.join(distDir, 'converter-index.js')
  await fs.writeFile(indexPath, indexBody, 'utf-8')
  return { indexPath, indexBytes: Buffer.byteLength(indexBody), chunkStats }
}

async function bundleWorker() {
  await build({
    entryPoints: [path.join(moduleRoot, 'src', 'worker.ts')],
    outfile: path.join(distDir, 'converter.worker.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    sourcemap: false,
    logLevel: 'info',
    banner: { js: BANNER },
    loader: { '.json': 'json' },
  })
}

async function main() {
  await fs.mkdir(distDir, { recursive: true })
  const chunks = await emitChunks()
  await bundleWorker()
  const workerPath = path.join(distDir, 'converter.worker.js')
  const workerBytes = (await fs.stat(workerPath)).size
  const totalChunkBytes = chunks.chunkStats.reduce((s, c) => s + c.bytes, 0)
  const summary = {
    worker: `${workerPath} (${workerBytes} bytes)`,
    index: `${chunks.indexPath} (${chunks.indexBytes} bytes)`,
    chunks: `${chunks.chunkStats.length} chunks / ${totalChunkBytes} bytes totais`,
  }
  console.log('lazy-load worker:', summary)
}

main().catch(err => { console.error(err); process.exit(1) })
