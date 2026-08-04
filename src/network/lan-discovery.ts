import { createSocket } from 'node:dgram'
import { pathToFileURL } from 'node:url'

export interface LanServerAnnouncement {
  host: string
  port: number
  motd: string
}

const multicastAddress = '224.0.2.60'
const multicastPort = 4445

export function parseLanAnnouncement(payload: string, host: string): LanServerAnnouncement | null {
  const motd = payload.match(/\[MOTD\]([\s\S]*?)\[\/MOTD\]/u)?.[1]?.trim()
  const portText = payload.match(/\[AD\](\d{1,5})\[\/AD\]/u)?.[1]
  const port = Number.parseInt(portText ?? '', 10)
  if (!motd || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port, motd }
}

export async function discoverLanServers(timeoutMs = 8000): Promise<LanServerAnnouncement[]> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 60_000) throw new Error('局域网发现超时必须在 250-60000ms 之间')
  return await new Promise((resolve, reject) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    const found = new Map<string, LanServerAnnouncement>()
    let finished = false
    const finish = (error?: Error): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      socket.close(() => error ? reject(error) : resolve([...found.values()]))
    }
    const timer = setTimeout(() => finish(), timeoutMs)
    socket.on('error', error => finish(error))
    socket.on('message', (message, remote) => {
      const announcement = parseLanAnnouncement(message.toString('utf8'), remote.address)
      if (announcement) found.set(`${announcement.host}:${announcement.port}`, announcement)
    })
    socket.bind(multicastPort, '0.0.0.0', () => {
      try { socket.addMembership(multicastAddress) } catch (error) { finish(error as Error) }
    })
  })
}

async function cli(): Promise<void> {
  const timeoutIndex = process.argv.indexOf('--timeout')
  const timeoutMs = timeoutIndex >= 0 ? Number.parseInt(process.argv[timeoutIndex + 1] ?? '', 10) : 8000
  const servers = await discoverLanServers(timeoutMs)
  process.stdout.write(`${JSON.stringify({ ok: true, servers })}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
