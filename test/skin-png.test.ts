import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateSync } from 'node:zlib'
import { validateMinecraftSkin } from '../src/skin/png.js'

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, content = Buffer.alloc(0)): Buffer {
  const name = Buffer.from(type, 'ascii')
  const value = Buffer.alloc(12 + content.length)
  value.writeUInt32BE(content.length, 0); name.copy(value, 4); content.copy(value, 8); value.writeUInt32BE(crc32(Buffer.concat([name, content])), 8 + content.length)
  return value
}

function image(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6
  const pixels = Buffer.alloc((width * 4 + 1) * height)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND')])
}

test('accepts standard modern and legacy Minecraft skin dimensions', () => {
  assert.deepEqual(validateMinecraftSkin(image(64, 64)), { width: 64, height: 64 })
  assert.deepEqual(validateMinecraftSkin(image(64, 32)), { width: 64, height: 32 })
})

test('rejects non-Minecraft PNG dimensions', () => {
  assert.throws(() => validateMinecraftSkin(image(128, 128)), /64x64/u)
  assert.throws(() => validateMinecraftSkin(image(64, 64).subarray(0, 40)), /有效|截断|缺少/u)
})
