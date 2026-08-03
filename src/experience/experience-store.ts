import { randomUUID } from 'node:crypto'
import { AtomicJsonFile } from '../core/atomic-json-file.js'

export interface ExperienceEntry {
  id: string
  createdAt: string
  updatedAt: string
  task: string
  context: string
  outcome: 'success' | 'failure' | 'partial'
  lesson: string
  correction: string
  tags: string[]
  timesApplied: number
  verified: boolean
}

export interface ExperienceDocument {
  schemaVersion: 1
  createdAt: string
  updatedAt: string
  entries: ExperienceEntry[]
}

function now(): string { return new Date().toISOString() }

export class ExperienceStore {
  readonly #file: AtomicJsonFile<ExperienceDocument>

  constructor(file: string) {
    this.#file = new AtomicJsonFile(file, () => ({ schemaVersion: 1, createdAt: now(), updatedAt: now(), entries: [] }))
  }

  get file(): string { return this.#file.file }
  async load(): Promise<ExperienceDocument> { return this.#file.load() }

  async add(entry: Omit<ExperienceEntry, 'id' | 'createdAt' | 'updatedAt' | 'timesApplied' | 'verified'>): Promise<ExperienceEntry> {
    const created: ExperienceEntry = { id: randomUUID(), createdAt: now(), updatedAt: now(), timesApplied: 0, verified: false, ...entry }
    await this.#file.update((document) => {
      document.entries.push(created)
      document.updatedAt = now()
    })
    return created
  }

  async relevant(text: string, limit = 8): Promise<ExperienceEntry[]> {
    const normalized = text.toLowerCase()
    const tokens = new Set(normalized.split(/[^\p{L}\p{N}_]+/u).filter((token) => token.length >= 2))
    const document = await this.#file.load()
    return document.entries
      .map((entry) => ({
        entry,
        score: entry.tags.reduce((score, tag) => score + (normalized.includes(tag.toLowerCase()) || tokens.has(tag.toLowerCase()) ? 2 : 0), 0)
          + [...tokens].reduce((score, token) => score + (entry.task.toLowerCase().includes(token) || entry.lesson.toLowerCase().includes(token) ? 1 : 0), 0)
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
      .slice(0, limit)
      .map(({ entry }) => entry)
  }
}
