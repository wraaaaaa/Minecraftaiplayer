import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

const CONFIRMATION = '--send-test-tone'
const projectRoot = path.resolve(import.meta.dirname, '..')

if (!process.argv.includes(CONFIRMATION)) {
  console.error(`用法: node scripts/test-voice-bridge.mjs ${CONFIRMATION}`)
  console.error('运行前必须停止 Node 控制器并保持 Minecraft/Fabric 客户端在线；测试会让 Bot 通过 Simple Voice Chat 发送约 0.6 秒的低音量提示音。')
  process.exitCode = 2
} else {
  await run()
}

async function run() {
  const configText = (await readFile(path.join(projectRoot, 'config', 'bot.json'), 'utf8')).replace(/^\uFEFF/u, '')
  const config = JSON.parse(configText)
  const host = String(config?.server?.bridgeHost ?? '127.0.0.1')
  const port = Number(config?.server?.bridgePort ?? 8765)
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error(`为避免暴露诊断桥，只允许回环 bridgeHost；当前为 ${host}`)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('bridgePort 无效')

  const pcm = makeTone(24_000, 0.6, 523.25, 0.06)
  const sessionId = randomUUID()
  const pending = new Map()
  let statusResolve
  let statusReject
  let activeSocket
  const status = new Promise((resolve, reject) => { statusResolve = resolve; statusReject = reject })
  const timeout = setTimeout(() => statusReject(new Error('等待 Simple Voice Chat 播放结果超时')), 30_000)

  const server = net.createServer(socket => {
    activeSocket = socket
    socket.setEncoding('utf8')
    socket.setNoDelay(true)
    let buffer = ''
    let started = false

    const sendAction = action => new Promise((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Fabric 动作超时: ${action.type}`))
      }, 8_000)
      pending.set(id, result => {
        clearTimeout(timer)
        if (!result.ok) reject(new Error(`${action.type}: ${result.detail}`))
        else resolve(result)
      })
      socket.write(`${JSON.stringify({ type: 'action', id, action })}\n`)
    })

    socket.on('data', chunk => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line) continue
        const message = JSON.parse(line)
        if (message.type === 'action_result' && pending.has(message.id)) {
          const resolve = pending.get(message.id)
          pending.delete(message.id)
          resolve(message)
        }
        if (message.type === 'voice_status' && String(message.detail ?? '').startsWith('voice_playback_')) {
          if (message.ok) statusResolve(message)
          else statusReject(new Error(String(message.detail ?? 'voice_playback_failed')))
        }
        if (message.type === 'hello' && !started) {
          started = true
          void (async () => {
            await sendAction({ type: 'voice_playback_begin', sessionId, sampleRate: 24_000, expectedBytes: pcm.length })
            await sendAction({ type: 'voice_playback_chunk', sessionId, sequence: 0, data: pcm.toString('base64') })
            await sendAction({ type: 'voice_playback_end', sessionId })
          })().catch(statusReject)
        }
      }
    })
    socket.on('error', statusReject)
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  try {
    const result = await status
    console.log(JSON.stringify({ ok: true, detail: result.detail, pcmBytes: pcm.length, sampleRate: 24_000 }))
  } finally {
    clearTimeout(timeout)
    for (const resolve of pending.values()) resolve({ ok: false, detail: 'diagnostic_finished' })
    pending.clear()
    activeSocket?.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}

function makeTone(sampleRate, seconds, frequency, amplitude) {
  const samples = Math.floor(sampleRate * seconds)
  const output = Buffer.allocUnsafe(samples * 2)
  for (let index = 0; index < samples; index++) {
    const fadeSamples = Math.floor(sampleRate * 0.04)
    const fadeIn = Math.min(1, index / fadeSamples)
    const fadeOut = Math.min(1, (samples - 1 - index) / fadeSamples)
    const envelope = Math.max(0, Math.min(fadeIn, fadeOut))
    const value = Math.round(Math.sin(2 * Math.PI * frequency * index / sampleRate) * 32767 * amplitude * envelope)
    output.writeInt16LE(value, index * 2)
  }
  return output
}
