import { randomUUID } from 'node:crypto'
import { AtomicJsonFile } from '../core/atomic-json-file.js'

export type DiagnosticEventType = 'request' | 'decision' | 'step' | 'result' | 'failure' | 'lifecycle'
export type DiagnosticLevel = 'info' | 'success' | 'warning' | 'error'

export interface DiagnosticEvent {
  id: string
  at: string
  type: DiagnosticEventType
  level: DiagnosticLevel
  title: string
  summary: string
  detail?: string
  taskId?: string
  playerName?: string
  metadata?: Record<string, string | number | boolean | null>
}

export interface DiagnosticDocument {
  schemaVersion: 1
  createdAt: string
  updatedAt: string
  events: DiagnosticEvent[]
}

export type NewDiagnosticEvent = Omit<DiagnosticEvent, 'id' | 'at'>

function now(): string { return new Date().toISOString() }

/** Persistent, local-only execution timeline consumed by the WebUI central chat. */
export class DiagnosticStore {
  readonly #file: AtomicJsonFile<DiagnosticDocument>
  readonly #maxEvents: number

  constructor(file = 'data/diagnostics.json', maxEvents = 1_000) {
    this.#maxEvents = Math.max(100, Math.min(10_000, maxEvents))
    this.#file = new AtomicJsonFile(file, () => ({
      schemaVersion: 1,
      createdAt: now(),
      updatedAt: now(),
      events: []
    }))
  }

  get file(): string { return this.#file.file }
  async load(): Promise<DiagnosticDocument> { return this.#file.load() }

  async append(event: NewDiagnosticEvent): Promise<void> {
    await this.#file.update(document => {
      if (document.schemaVersion !== 1 || !Array.isArray(document.events)) throw new Error('诊断文件格式无效')
      document.events.push({ id: randomUUID(), at: now(), ...event })
      if (document.events.length > this.#maxEvents) document.events.splice(0, document.events.length - this.#maxEvents)
      document.updatedAt = now()
    })
  }
}
