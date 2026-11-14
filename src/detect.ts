// Porta de convert/flashforge/detect.py (v0.2.3).
import JSZip from 'jszip'

export const SETTINGS = 'Metadata/project_settings.config'
export const MAX_MEMBERS = 20000
export const MAX_UNCOMPRESSED = 2 * 1024 ** 3

export const DETECT_MESSAGES: Record<string, string> = {
  bambu_project: 'Projeto Bambu Studio/MakerWorld - pode ser convertido.',
  flashforge: 'O arquivo já é um projeto para impressora Flashforge; nada a converter.',
  sliced_only: 'Arquivo fatiado (G-code) sem modelo 3D editável. No MakerWorld baixe o arquivo de projeto (perfil de impressão .3mf), não o .gcode.3mf.',
  mesh_only: '3MF só com malha, sem configurações de impressão. Não há perfil para preservar: abra-o direto no Orca/Flash Studio ou baixe no MakerWorld o perfil de impressão (.3mf de projeto).',
  prusa_project: 'Projeto PrusaSlicer (Printables) ainda não é suportado por este conversor.',
  stl: 'Arquivo STL: só malha, sem configurações. Abra-o direto no Orca/Flash Studio.',
  not_3mf: 'Arquivo não é um 3MF válido.',
}

export type DetectResult = {
  kind: 'bambu_project' | 'flashforge' | 'sliced_only' | 'mesh_only' | 'prusa_project' | 'stl' | 'not_3mf'
  message: string
  app: string
  printer_model: string
  printer_settings_id: string
  has_gcode: boolean
  filaments: number
  plates: number
  reason?: string
}

function looksStl(head: Uint8Array): boolean {
  const start = new TextDecoder().decode(head.slice(0, 5)).toLowerCase()
  if (start === 'solid') return true
  return head.length >= 84 && !(head[0] === 0x50 && head[1] === 0x4b)
}

function hasTriangles(bytes: Uint8Array): boolean {
  const txt = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  return /<triangle\b/.test(txt)
}

export async function detect(source: Blob | ArrayBuffer | Uint8Array): Promise<DetectResult> {
  const info: DetectResult = {
    kind: 'not_3mf', app: '', printer_model: '', printer_settings_id: '',
    has_gcode: false, filaments: 0, plates: 0, message: '',
  }
  const bytes = source instanceof Uint8Array ? source
    : source instanceof ArrayBuffer ? new Uint8Array(source)
      : new Uint8Array(await source.arrayBuffer())
  const head = bytes.subarray(0, 512)
  if (head.length === 0 || !(head[0] === 0x50 && head[1] === 0x4b)) {
    info.kind = looksStl(head) ? 'stl' : 'not_3mf'
    info.message = DETECT_MESSAGES[info.kind]
    return info
  }
  let z: JSZip
  try {
    z = await JSZip.loadAsync(bytes)
  } catch (e) {
    info.kind = 'not_3mf'
    info.reason = 'corrupt_zip'
    info.message = `Arquivo .3mf corrompido ou incompleto (${e instanceof Error ? e.name : 'ZipError'}).`
    return info
  }
  const entries = Object.values(z.files).filter(f => !f.dir)
  const names = entries.map(f => f.name)
  let uncompressed = 0
  for (const entry of entries) {
    const anyEntry = entry as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } }
    uncompressed += anyEntry._data?.uncompressedSize ?? 0
  }
  if (entries.length > MAX_MEMBERS || uncompressed > MAX_UNCOMPRESSED) {
    info.kind = 'not_3mf'
    info.reason = 'too_large_uncompressed'
    info.message = 'Arquivo grande demais ou suspeito (limite de segurança).'
    return info
  }
  if (!names.includes('3D/3dmodel.model')) {
    info.kind = 'not_3mf'
    info.reason = 'no_3d_model'
    info.message = DETECT_MESSAGES.not_3mf + ' (falta 3D/3dmodel.model)'
    return info
  }
  const rootBytes = await z.file('3D/3dmodel.model')!.async('uint8array')
  const headText = new TextDecoder('utf-8', { fatal: false }).decode(rootBytes.subarray(0, 6000))
  const appMatch = headText.match(/name="Application">([^<]*)</)
  info.app = appMatch ? appMatch[1] : ''
  info.has_gcode = names.some(n => /^Metadata\/plate_\d+\.gcode$/.test(n))
  info.plates = names.filter(n => /^Metadata\/plate_\d+\.png$/.test(n)).length

  let hasMesh = false
  for (const name of names) {
    if (/\.model$/i.test(name)) {
      const bytes = await z.file(name)!.async('uint8array')
      if (hasTriangles(bytes)) { hasMesh = true; break }
    }
  }

  if (names.includes(SETTINGS)) {
    let s: Record<string, unknown>
    try {
      s = JSON.parse(await z.file(SETTINGS)!.async('string'))
    } catch {
      info.kind = 'not_3mf'
      info.reason = 'invalid_project_settings'
      info.message = 'project_settings.config ilegível (JSON inválido).'
      return info
    }
    info.printer_model = String(s.printer_model ?? '')
    info.printer_settings_id = String(s.printer_settings_id ?? '')
    const colour = Array.isArray(s.filament_colour) ? (s.filament_colour as unknown[]) : []
    info.filaments = colour.length || 1
    if (!hasMesh) {
      info.kind = info.has_gcode ? 'sliced_only' : 'mesh_only'
      if (info.kind === 'mesh_only') {
        info.message = 'Projeto sem nenhuma malha (modelo vazio).'
        return info
      }
    } else if ((info.printer_model + info.printer_settings_id).toLowerCase().includes('flashforge')) {
      info.kind = 'flashforge'
    } else {
      info.kind = 'bambu_project'
    }
  } else if (names.some(n => n.endsWith('Slic3r_PE.config') || n.endsWith('PrusaSlicer.config'))) {
    info.kind = 'prusa_project'
  } else if (info.has_gcode && !hasMesh) {
    info.kind = 'sliced_only'
  } else {
    info.kind = 'mesh_only'
  }
  if (!info.message) info.message = DETECT_MESSAGES[info.kind]
  return info
}
