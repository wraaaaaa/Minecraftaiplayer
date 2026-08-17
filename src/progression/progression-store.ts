import { AtomicJsonFile } from '../core/atomic-json-file.js'

export type ProgressionStage =
  | 'survive'
  | 'wood_age'
  | 'stone_age'
  | 'iron_age'
  | 'diamond_age'
  | 'enchanting'

export interface ProgressionFailure {
  count: number
  lastAt: string
  detail: string
}

export interface ProgressionDocument {
  schemaVersion: 1
  stage: ProgressionStage
  updatedAt: string
  lastAction?: string
  lastReason?: string
  lastResult?: { ok: boolean; detail: string; at: string }
  milestones: Record<string, string>
  failures: Record<string, ProgressionFailure>
}

const STAGE_ORDER: readonly ProgressionStage[] = [
  'survive', 'wood_age', 'stone_age', 'iron_age', 'diamond_age', 'enchanting'
]

function initialDocument(): ProgressionDocument {
  return {
    schemaVersion: 1,
    stage: 'survive',
    updatedAt: new Date().toISOString(),
    milestones: {},
    failures: {}
  }
}

/** 自主生存进度的持久化、原子化检查点。 */
export class ProgressionStore {
  readonly #file: AtomicJsonFile<ProgressionDocument>

  constructor(file = 'data/progression.json') {
    this.#file = new AtomicJsonFile(file, initialDocument)
  }

  get file(): string { return this.#file.file }

  load(): Promise<ProgressionDocument> { return this.#file.load() }

  async notePlan(stage: ProgressionStage, action: string, reason: string): Promise<void> {
    await this.#file.update(document => {
      // 旅途中出现安全/食物方面的绕行是正常的。它们不能让持久化的
      // 交接检查点看起来从铁器/钻石/下界阶段倒退回“survive”或木器阶段。
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
