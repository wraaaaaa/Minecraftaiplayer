import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const PRIORITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') }

function redactString(value: string, secrets: string[] = []): string {
  let redacted = value
  for (const secret of secrets) if (secret.length >= 4) redacted = redacted.replace(new RegExp(escapeRegExp(secret), 'gu'), '[REDACTED]')
  return redacted
    .replace(/\/login\s+\S+/giu, '/login [REDACTED]')
    .replace(/\/register\s+\S+(?:\s+\S+)?/giu, '/register [REDACTED]')
    .replace(/(api[_-]?key|authorization|password|token)(["'\s:=]+)[^\s,"'}]+/giu, '$1$2[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/giu, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/giu, 'Bearer [REDACTED]')
}

function sanitize(value: unknown, secrets: string[], seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value, secrets)
  if (value instanceof Error) return { name: value.name, message: redactString(value.message, secrets), stack: value.stack ? redactString(value.stack, secrets) : undefined }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, secrets, seen))
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /password|secret|token|api.?key|authorization/iu.test(key) ? '[REDACTED]' : sanitize(item, secrets, seen)]))
  }
  return value
}

export class Logger {
  readonly #file: string
  readonly #level: LogLevel
  readonly #console: boolean
  readonly #secrets: string[]
  #writeChain = Promise.resolve()

  constructor(options: { file: string; level: LogLevel; console: boolean; secrets?: string[] }) {
    this.#file = path.resolve(options.file)
    this.#level = options.level
    this.#console = options.console
    this.#secrets = (options.secrets ?? []).filter(secret => secret.length >= 4)
  }

  debug(message: string, data?: unknown): void { this.#log('debug', message, data) }
  info(message: string, data?: unknown): void { this.#log('info', message, data) }
  warn(message: string, data?: unknown): void { this.#log('warn', message, data) }
  error(message: string, data?: unknown): void { this.#log('error', message, data) }

  async flush(): Promise<void> { await this.#writeChain }

  #log(level: LogLevel, message: string, data?: unknown): void {
    if (PRIORITY[level] < PRIORITY[this.#level]) return
    const entry = { time: new Date().toISOString(), level, message: redactString(message, this.#secrets), ...(data === undefined ? {} : { data: sanitize(data, this.#secrets) }) }
    const line = `${JSON.stringify(entry)}\n`
    this.#writeChain = this.#writeChain.then(async () => {
      await mkdir(path.dirname(this.#file), { recursive: true })
      await appendFile(this.#file, line, 'utf8')
    }).catch(() => undefined)
    if (this.#console) {
      const output = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
      output(`[${entry.time}] ${level.toUpperCase()} ${entry.message}`, entry.data ?? '')
    }
  }
}

export { redactString }
