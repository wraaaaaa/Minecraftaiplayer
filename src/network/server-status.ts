import { connect } from 'node:net'

export interface ServerStatus {
  online: number
  max: number
  version: string
  description: string
  latencyMs: number | undefined
}

/** Minecraft 协议 VarInt（LEB128，最多 5 字节）。 */
function writeVarInt(value: number): Buffer {
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

function writeString(value: string): Buffer {
  const body = Buffer.from(value, 'utf8')
  return Buffer.concat([writeVarInt(body.length), body])
}

interface ReadResult { value: number; length: number }

function readVarInt(buffer: Buffer, offset: number): ReadResult {
  let value = 0
  let position = 0
  let index = offset
  while (true) {
    if (index >= buffer.length) throw new Error('VarInt 数据不完整')
    const byte = buffer[index]!
    if (position === 4 && (byte & 0x7f) > 0x0f) throw new Error('VarInt 第 5 字节溢出')
    value |= (byte & 0x7f) << (7 * position)
    index++
    if ((byte & 0x80) === 0) break
    position++
    if (position >= 5) throw new Error('VarInt 过长')
  }
  return { value, length: index - offset }
}

function readString(buffer: Buffer, offset: number): { value: string; length: number } {
  const lengthResult = readVarInt(buffer, offset)
  const start = offset + lengthResult.length
  const end = start + lengthResult.value
  if (end > buffer.length) throw new Error('字符串数据不完整')
  return { value: buffer.subarray(start, end).toString('utf8'), length: lengthResult.length + lengthResult.value }
}

/**
 * 使用 Server List Ping 协议查询 Minecraft 服务器的状态。
 * 这是一个短暂的、未经认证的连接：它从不登录，也从不
 * 占用玩家槽位，因此可以在不打扰服务器的情况下轮询玩家数量。
 */
export function queryServerStatus(host: string, port: number, protocolVersion: number, timeoutMs = 5000): Promise<ServerStatus> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    let settled = false
    let buffer = Buffer.alloc(0)
    let startedAt = Date.now()

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error('Server status query timed out after ' + timeoutMs + 'ms'))
    }, timeoutMs)

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    }

    socket.on('connect', () => {
      startedAt = Date.now()
      const handshakeBody = Buffer.concat([
        writeVarInt(0x00),
        writeVarInt(protocolVersion),
        writeString(host),
        (() => { const b = Buffer.alloc(2); b.writeUInt16BE(port & 0xffff, 0); return b })(),
        writeVarInt(1)
      ])
      const handshake = Buffer.concat([writeVarInt(handshakeBody.length), handshakeBody])
      const request = Buffer.concat([writeVarInt(1), writeVarInt(0x00)])
      socket.write(Buffer.concat([handshake, request]))
    })

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      try {
        const lengthResult = readVarInt(buffer, 0)
        if (buffer.length < lengthResult.length + lengthResult.value) return
        const packet = buffer.subarray(lengthResult.length, lengthResult.length + lengthResult.value)
        const packetIdResult = readVarInt(packet, 0)
        if (packetIdResult.value !== 0x00) return
        const jsonResult = readString(packet, packetIdResult.length)
        const parsed = JSON.parse(jsonResult.value) as { version?: { name?: string }; players?: { online?: number; max?: number }; description?: unknown }
        const latencyMs = Date.now() - startedAt
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.end()
        resolve({
          online: typeof parsed.players?.online === 'number' ? parsed.players.online : 0,
          max: typeof parsed.players?.max === 'number' ? parsed.players.max : 0,
          version: typeof parsed.version?.name === 'string' ? parsed.version.name : '',
          description: typeof parsed.description === 'string' ? parsed.description : '',
          latencyMs
        })
      } catch (error) {
        if (error instanceof SyntaxError) fail(error)
      }
    })

    socket.on('error', (error) => fail(error instanceof Error ? error : new Error(String(error))))
    socket.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('Server closed the connection before sending a status response'))
    })
    socket.on('timeout', () => { socket.destroy() })
  })
}
