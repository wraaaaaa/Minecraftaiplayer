import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import type { BotConfig } from '../config/types.js'
import type { LlmInputAttachment, ModelCapabilities } from '../llm/types.js'
import type { WorldState } from './world-state.js'

export interface SensorySnapshot {
  attachments: LlmInputAttachment[]
  status: {
    vision: 'disabled' | 'semantic_map' | 'camera_frame'
    audio: 'disabled' | 'unavailable' | 'voice_frame'
    attachmentBytes: number
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(input: Buffer): number {
  let value = 0xffffffff
  for (const byte of input) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, checksum])
}

function semanticMap(world: WorldState): Buffer {
  const size = 128
  const pixels = Buffer.alloc(size * size * 3, 24)
  const centerX = world.position?.x ?? 0
  const centerZ = world.position?.z ?? 0
  const scale = 4
  const paint = (x: number, z: number, color: readonly [number, number, number], radius = 1) => {
    const px = Math.round(size / 2 + (x - centerX) * scale)
    const pz = Math.round(size / 2 + (z - centerZ) * scale)
    for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
      const column = px + dx
      const row = pz + dz
      if (column < 0 || row < 0 || column >= size || row >= size) continue
      const offset = (row * size + column) * 3
      pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2]
    }
  }
  for (const block of world.nearbyBlocks ?? []) {
    const color: readonly [number, number, number] = block.fluid ? [38, 122, 214]
      : block.classification === 'protected_likely' ? [152, 92, 188]
        : block.resourceCategory && !['stone', 'dirt'].includes(block.resourceCategory) ? [245, 177, 54]
          : block.classification === 'bot_owned' ? [236, 126, 42]
            : [92, 112, 84]
    paint(block.x, block.z, color)
  }
  for (const player of world.nearbyPlayers) if (player.position) paint(player.position.x, player.position.z, [55, 155, 255], 2)
  for (const entity of world.nearbyHostiles ?? []) if (entity.position) paint(entity.position.x, entity.position.z, [235, 64, 52], 2)
  for (const entity of world.nearbyCreatures ?? []) if (entity.position) paint(entity.position.x, entity.position.z, [74, 190, 102], 1)
  paint(centerX, centerZ, [255, 245, 230], 2)

  const raw = Buffer.alloc((size * 3 + 1) * size)
  for (let row = 0; row < size; row++) {
    const target = row * (size * 3 + 1)
    raw[target] = 0
    pixels.copy(raw, target + 1, row * size * 3, (row + 1) * size * 3)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4)
  header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ])
}

async function freshFile(file: string, maximumAgeMs: number, maximumBytes: number): Promise<Buffer | undefined> {
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size <= 0 || info.size > maximumBytes || Date.now() - info.mtimeMs > maximumAgeMs) return undefined
    return await readFile(file)
  } catch { return undefined }
}

export async function sensorySnapshot(config: BotConfig['model'], capabilities: ModelCapabilities | undefined, world: WorldState): Promise<SensorySnapshot> {
  const enabled = config.multimodal ?? {
    autoDetect: true, visionEnabled: true, audioEnabled: true, onlineResearchEnabled: true, sensoryDirectory: 'data/sensory'
  }
  const directory = path.resolve(enabled.sensoryDirectory)
  const attachments: LlmInputAttachment[] = []
  let vision: SensorySnapshot['status']['vision'] = 'disabled'
  let audio: SensorySnapshot['status']['audio'] = 'disabled'
  if (capabilities?.vision && enabled.visionEnabled) {
    const camera = await freshFile(path.join(directory, 'latest.png'), 15_000, 1_500_000)
    const image = camera ?? semanticMap(world)
    attachments.push({ type: 'image', mimeType: 'image/png', dataBase64: image.toString('base64') })
    vision = camera ? 'camera_frame' : 'semantic_map'
  }
  if (capabilities?.audio && enabled.audioEnabled) {
    audio = 'unavailable'
    try {
      const descriptor = JSON.parse(await readFile(path.join(directory, 'latest-audio.json'), 'utf8')) as { capturedAt?: string; mimeType?: string; dataBase64?: string }
      const capturedAt = Date.parse(descriptor.capturedAt ?? '')
      const bytes = typeof descriptor.dataBase64 === 'string' ? Buffer.from(descriptor.dataBase64, 'base64') : Buffer.alloc(0)
      if (Number.isFinite(capturedAt) && Date.now() - capturedAt <= 15_000 && bytes.length > 0 && bytes.length <= 2_000_000
        && typeof descriptor.mimeType === 'string' && /^audio\/(?:wav|mpeg|mp3|ogg|webm|flac)$/iu.test(descriptor.mimeType)) {
        attachments.push({ type: 'audio', mimeType: descriptor.mimeType, dataBase64: bytes.toString('base64') })
        audio = 'voice_frame'
      }
    } catch { /* Voice Chat integration is optional; absence is an explicit status, not an error. */ }
  }
  return { attachments, status: { vision, audio, attachmentBytes: attachments.reduce((sum, item) => sum + Buffer.byteLength(item.dataBase64, 'base64'), 0) } }
}
