import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type Server } from 'node:net'
import { queryServerStatus } from '../src/network/server-status.js'

function varint(value: number): Buffer {
  const bytes: number[] = []
  let current = value >>> 0
  do {
    let byte = current & 0x7f
    current >>>= 7
    if (current !== 0) byte |= 0x80
    bytes.push(byte)
  } while (current !== 0)
  return Buffer.from(bytes)
}

function string(value: string): Buffer {
  const body = Buffer.from(value, 'utf8')
  return Buffer.concat([varint(body.length), body])
}

test('Server List Ping 查询能解析在线人数而不登录占位', async () => {
  const server: Server = createServer((socket) => {
    socket.on('data', () => {
      const json = JSON.stringify({
        version: { name: '26.2', protocol: 776 },
        players: { online: 3, max: 20 },
        description: { text: 'test' }
      })
      const body = Buffer.concat([varint(0x00), string(json)])
      socket.write(Buffer.concat([varint(body.length), body]))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : 0
  try {
    const status = await queryServerStatus('127.0.0.1', port, 776, 5000)
    assert.equal(status.online, 3)
    assert.equal(status.max, 20)
    assert.equal(status.version, '26.2')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
