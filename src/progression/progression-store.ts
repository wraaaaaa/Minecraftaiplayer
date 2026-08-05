import { AtomicJsonFile } from '../core/atomic-json-file.js'

export type ProgressionStage =
  | 'survive'
  | 'wood_age'
  | 'stone_age'
  | 'iron_age'
  | 'diamond_age'
  | 'enchanting'
  | 'nether'
  | 'stronghold'
  | 'end'
  | 'complete'

export interface ProgressionFailure {
  count: number
  lastAt: string
  detail: string
}

export interface ProgressionDocument {
  schemaVersion: 1
  goal: 'reach_end'
  stage: ProgressionStage
  updatedAt: string
  lastAction?: string
  lastReason?: string
  lastResult?: { ok: boolean; detail: string; at: string }
  milestones: Record<string, string>
  failures: Record<string, ProgressionFailure>
}

const STAGE_ORDER: readonly ProgressionStage[] = [
  'survive', 'wood_age', 'stone_age', 'iron_age', 'diamond_age',
  'enchanting', 'nether', 'stronghold', 'end', 'complete'
]

function initialDocument(): ProgressionDocument {
  return {
    schemaVersion: 1,
    goal: 'reach_end',
    stage: 'survive',
    updatedAt: new Date().toISOString(),
    milestones: {},
    failures: {}
  }
}

/** Persistent, atomic checkpoint for autonomous survival progression. */
export class ProgressionStore {
  readonly #file: AtomicJsonFile<ProgressionDocument>

  constructor(file = 'data/progression.json') {
    this.#file = new AtomicJsonFile(file, initialDocument)
  }

  get file(): string { return this.#file.file }

  load(): Promise<ProgressionDocument> { return this.#file.load() }

  async notePlan(stage: ProgressionStage, action: string, reason: string): Promise<void> {
    await this.#file.update(document => {
      // Safety/food detours are expected throughout the journey. They must not make the durable
      // handoff checkpoint appear to regress from iron/diamond/Nether back to "survive" or wood.
      if (STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(document.stage)) document.stage = stage
      document.lastAction = action
      document.lastReason = reason
      document.updatedAt = new Date().toISOString()
      document.milestones[`entered:${stage}`] ??= document.updatedAt
    })
  }

  async noteResult(action: string, ok: boolean, detail: string, failureKey = action): Promise<void> {
    await this.#file.update(document => {
      const at = new Date().toISOString()
      document.lastAction = action
      document.lastResult = { ok, detail: detail.slice(0, 2000), at }
      document.updatedAt = at
      if (ok) {
        document.milestones[`completed:${action}`] = at
        delete document.failures[action]
        delete document.failures[failureKey]
      } else {
        const previous = document.failures[failureKey]
        document.failures[failureKey] = {
          count: (previous?.count ?? 0) + 1,
          lastAt: at,
          detail: detail.slice(0, 2000)
        }
      }
    })
  }
}
