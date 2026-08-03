import mineflayer from 'mineflayer'
import { loadProjectConfig } from './config/load-config.js'
import { redactString } from './core/logger.js'

const { config } = await loadProjectConfig({ allowExample: true })
const username = `${config.server.username.slice(0, 9)}P${String(Date.now()).slice(-5)}`
const result: Record<string, unknown> = { server: `${config.server.host}:${config.server.port}`, requestedVersion: config.server.version, username, events: [] }
const events = result.events as unknown[]
const bot = mineflayer.createBot({ host: config.server.host, port: config.server.port, username, auth: 'offline', version: config.server.version, hideErrors: true, logErrors: false })

function safeDetail(detail: unknown): unknown {
  if (typeof detail === 'string') return redactString(detail)
  try { return JSON.parse(redactString(JSON.stringify(detail))) as unknown } catch { return redactString(String(detail)) }
}

function event(type: string, detail?: unknown): void { events.push({ at: new Date().toISOString(), type, ...(detail === undefined ? {} : { detail: safeDetail(detail) }) }) }

bot.on('login', () => event('login', { negotiatedVersion: bot.version }))
bot.on('spawn', () => { event('spawn', { position: bot.entity.position }); setTimeout(() => bot.quit('probe complete'), 3000).unref() })
bot.on('messagestr', (message) => event('message', message))
bot.on('kicked', (reason) => event('kicked', reason))
bot.on('error', (error) => event('error', error.message))
bot.on('end', (reason) => { event('end', reason); console.log(JSON.stringify(result, null, 2)); process.exitCode = events.some((item) => (item as { type?: string }).type === 'spawn') ? 0 : 1 })

setTimeout(() => { event('timeout'); bot.quit('probe timeout') }, config.server.connectTimeoutMs).unref()
