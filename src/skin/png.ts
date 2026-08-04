export interface PngDimensions {
  width: number
  height: number
}

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function pngDimensions(data: Buffer): PngDimensions {
  if (data.length < 57 || !data.subarray(0, 8).equals(pngSignature)) throw new Error('文件不是有效的 PNG 图片')
  let offset = 8
  let dimensions: PngDimensions | undefined
  let sawImageData = false
  let sawEnd = false
  while (offset < data.length) {
    if (offset + 12 > data.length) throw new Error('PNG 文件已截断')
    const length = data.readUInt32BE(offset)
    const typeStart = offset + 4
    const contentStart = offset + 8
    const contentEnd = contentStart + length
    const chunkEnd = contentEnd + 4
    if (chunkEnd > data.length) throw new Error('PNG 数据块已截断')
    const type = data.subarray(typeStart, contentStart).toString('ascii')
    const expectedCrc = data.readUInt32BE(contentEnd)
    const actualCrc = crc32(data.subarray(typeStart, contentEnd))
    if (actualCrc !== expectedCrc) throw new Error(`PNG ${type} 数据块 CRC 无效`)
    if (!dimensions) {
      if (type !== 'IHDR' || length !== 13) throw new Error('PNG 的第一个数据块必须是 IHDR')
      const width = data.readUInt32BE(contentStart)
      const height = data.readUInt32BE(contentStart + 4)
      if (width < 1 || height < 1 || data[contentStart + 10] !== 0 || data[contentStart + 11] !== 0 || ![0, 1].includes(data[contentStart + 12] ?? -1)) throw new Error('PNG IHDR 参数无效')
      dimensions = { width, height }
    } else if (type === 'IDAT') {
      sawImageData = true
    } else if (type === 'IEND') {
      if (length !== 0) throw new Error('PNG IEND 数据块无效')
      sawEnd = true
      offset = chunkEnd
      break
    }
    offset = chunkEnd
  }
  if (!dimensions || !sawImageData || !sawEnd || offset !== data.length) throw new Error('PNG 缺少完整的 IDAT/IEND 数据块')
  return dimensions
}

export function validateMinecraftSkin(data: Buffer): PngDimensions {
  if (data.length > 1024 * 1024) throw new Error('皮肤文件不能超过 1 MiB')
  const dimensions = pngDimensions(data)
  if (!((dimensions.width === 64 && dimensions.height === 64) || (dimensions.width === 64 && dimensions.height === 32))) {
    throw new Error(`皮肤必须是 64x64（现代格式）或 64x32（旧格式）PNG，当前为 ${dimensions.width}x${dimensions.height}`)
  }
  return dimensions
}

export function decodePngDataUrl(value: unknown): Buffer {
  if (typeof value !== 'string') throw new Error('缺少皮肤图片数据')
  const match = value.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/u)
  if (!match?.[1]) throw new Error('皮肤只能上传 PNG 文件')
  return Buffer.from(match[1], 'base64')
}
