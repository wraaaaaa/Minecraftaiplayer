import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const PRIORITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function redactString(value: string): string {
  return value
    .replace(/\/login\s+\S+/giu, '/login [REDACTED]')
    .replace(/\/register\s+\S+(?:\s+\S+)?/giu, '/register [REDACTED]')
    .replace(/(api[_-]?key|authorization|password|token)(["'\s:=]+)[^\s,"'}]+/giu, '$1$2[REDACTED]')
}

function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value)
  if (value instanceof Error) return { name: value.name, message: redactString(value.message), stack: value.stack ? redactString(value.stack) : undefined }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen))
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /password|secret|token|api.?key|authorization/iu.test(key) ? '[REDACTED]' : sanitize(item, seen)]))
  }
  return value
}

export class Logger {
  readonly #file: string
  readonly #level: LogLevel
  readonly #console: boolean
  #writeChain = Promise.resolve()

  constructor(options: { file: string; level: LogLevel; console: boolean }) {
    this.#file = path.resolve(options.file)
    this.#level = options.level
    this.#console = options.console
  }

  debug(message: string, data?: unknown): void { this.#log('debug', message, data) }
  info(message: string, data?: unknown): void { this.#log('info', message, data) }
  warn(message: string, data?: unknown): void { this.#log('warn', message, data) }
  error(message: string, data?: unknown): void { this.#log('error', message, data) }

  async flush(): Promise<void> { await this.#writeChain }

  #log(level: LogLevel, message: string, data?: unknown): void {
    if (PRIORITY[level] < PRIORITY[this.#level]) return
    const entry = { time: new Date().toISOString(), level, message: redactString(message), ...(data === undefined ? {} : { data: sanitize(data) }) }
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
