import { randomUUID } from 'node:crypto'
import { AtomicJsonFile } from '../core/atomic-json-file.js'

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed'
export type TaskSource = 'player' | 'webui_admin'

export interface TaskIssuer {
  name: string
  uuid?: string
}

export interface TaskRecord {
  id: string
  issuer: TaskIssuer
  request: string
  source?: TaskSource
  urgency: number
  status: TaskStatus
  sequence: number
  attempts: number
  requeueCount: number
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
  result?: string
  error?: string
  lastTransitionReason?: string
}

export interface TaskDocument {
  schemaVersion: 1
  createdAt: string
  updatedAt: string
  nextSequence: number
  tasks: TaskRecord[]
}

export interface NewTask {
  issuer: TaskIssuer
  request: string
  urgency?: number
  source?: TaskSource
}

export type PlayerDistanceResolver = (issuer: Readonly<TaskIssuer>) => number | undefined

function now(): string { return new Date().toISOString() }

function taskCopy(task: TaskRecord): TaskRecord { return structuredClone(task) }

function issuerKey(issuer: TaskIssuer): string {
  const uuid = issuer.uuid?.trim().toLowerCase()
  return uuid ? `uuid:${uuid}` : `name:${issuer.name.trim().toLowerCase()}`
}

function compareWithinIssuer(left: TaskRecord, right: TaskRecord): number {
  return right.urgency - left.urgency || left.sequence - right.sequence || left.id.localeCompare(right.id)
}

function normalizedDistance(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : Number.POSITIVE_INFINITY
}

function requireTask(document: TaskDocument, id: string): TaskRecord {
  const task = document.tasks.find((candidate) => candidate.id === id)
  if (!task) throw new Error(`任务不存在：${id}`)
  return task
}

function validateDocument(document: TaskDocument): void {
  if (!document || typeof document !== 'object' || document.schemaVersion !== 1) {
    throw new Error('不支持的任务文件格式：schemaVersion 必须为 1')
  }
  if (!Array.isArray(document.tasks) || !Number.isSafeInteger(document.nextSequence) || document.nextSequence < 0) {
    throw new Error('任务文件内容无效')
  }
}

export class TaskStore {
  readonly #file: AtomicJsonFile<TaskDocument>
  readonly #ownerName: string
  #initialization: Promise<void> | undefined
  #operationChain = Promise.resolve()

  constructor(file: string, options: { ownerName?: string } = {}) {
    const timestamp = now()
    this.#ownerName = (options.ownerName ?? 'wraaaaaa').trim().toLowerCase()
    if (!this.#ownerName) throw new Error('ownerName 不能为空')
    this.#file = new AtomicJsonFile(file, () => ({
      schemaVersion: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      nextSequence: 0,
      tasks: []
    }))
  }

  get file(): string { return this.#file.file }

  async load(): Promise<TaskDocument> {
    return this.#exclusive(async (document) => structuredClone(document))
  }

  async enqueue(input: NewTask): Promise<TaskRecord> {
    const name = input.issuer.name.trim()
    const request = input.request.trim()
    const uuid = input.issuer.uuid?.trim()
    if (!name) throw new Error('任务发令者名称不能为空')
    if (!request) throw new Error('任务内容不能为空')
    const urgency = input.urgency ?? 0
    if (!Number.isInteger(urgency) || urgency < 0 || urgency > 100) throw new Error('任务 urgency 必须是 0-100 的整数')

    return this.#exclusive(async (document) => {
      const timestamp = now()
      const task: TaskRecord = {
        id: randomUUID(),
        issuer: { name, ...(uuid ? { uuid } : {}) },
        request,
        source: input.source ?? 'player',
        urgency,
        status: 'queued',
        sequence: document.nextSequence,
        attempts: 0,
        requeueCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp
      }
      document.nextSequence++
      document.tasks.push(task)
      document.updatedAt = timestamp
      await this.#file.save(document)
      return taskCopy(task)
    })
  }

  /**
   * Atomically selects and reserves the next task. A non-null result is already
   * in the running state, so two callers cannot start different tasks at once.
   */
  async takeNext(resolveDistance: PlayerDistanceResolver = () => undefined): Promise<TaskRecord | null> {
    return this.#exclusive(async (document) => {
      if (document.tasks.some((task) => task.status === 'running')) return null
      const queued = document.tasks.filter((task) => task.status === 'queued')
      if (queued.length === 0) return null

      const administrators = queued.filter(task => task.source === 'webui_admin').sort(compareWithinIssuer)
      const owners = queued.filter((task) => task.source !== 'webui_admin' && this.#isOwner(task.issuer)).sort(compareWithinIssuer)
      const selected = administrators[0] ?? owners[0] ?? this.#selectNearestPlayerTask(queued, resolveDistance)
      if (!selected) return null
      this.#transitionToRunning(selected)
      document.updatedAt = selected.updatedAt
      await this.#file.save(document)
      return taskCopy(selected)
    })
  }

  async markRunning(id: string): Promise<TaskRecord> {
    return this.#exclusive(async (document) => {
      const task = requireTask(document, id)
      if (task.status === 'running') return taskCopy(task)
      if (task.status !== 'queued') throw new Error(`任务 ${id} 当前状态 ${task.status}，不能开始执行`)
      const active = document.tasks.find((candidate) => candidate.status === 'running')
      if (active) throw new Error(`已有任务正在执行：${active.id}`)
      this.#transitionToRunning(task)
      document.updatedAt = task.updatedAt
      await this.#file.save(document)
      return taskCopy(task)
    })
  }

  async complete(id: string, result = ''): Promise<TaskRecord> {
    return this.#finish(id, 'completed', result)
  }

  async fail(id: string, error: string): Promise<TaskRecord> {
    if (!error.trim()) throw new Error('任务失败原因不能为空')
    return this.#finish(id, 'failed', error)
  }

  async requeue(id: string, reason = ''): Promise<TaskRecord> {
    return this.#exclusive(async (document) => {
      const task = requireTask(document, id)
      if (task.status === 'completed') throw new Error(`已完成任务 ${id} 不能重新排队`)
      if (task.status === 'queued') return taskCopy(task)
      const timestamp = now()
      task.status = 'queued'
      task.updatedAt = timestamp
      task.requeueCount++
      if (reason.trim()) task.lastTransitionReason = reason.trim()
      delete task.startedAt
      delete task.finishedAt
      delete task.result
      document.updatedAt = timestamp
      await this.#file.save(document)
      return taskCopy(task)
    })
  }

  /** Requeues every orphaned running task after a controller/client reconnect. */
  async recoverRunning(reason = 'controller_recovery'): Promise<number> {
    return this.#exclusive(async (document) => {
      const running = document.tasks.filter(task => task.status === 'running')
      if (running.length === 0) return 0
      const timestamp = now()
      for (const task of running) {
        task.status = 'queued'
        task.updatedAt = timestamp
        task.requeueCount++
        task.lastTransitionReason = reason.trim() || 'controller_recovery'
        delete task.startedAt
        delete task.finishedAt
        delete task.result
      }
      document.updatedAt = timestamp
      await this.#file.save(document)
      return running.length
    })
  }

  /** Marks the current task failed so an out-of-band stop command can preempt it. */
  async cancelRunning(reason = 'cancelled_by_player'): Promise<TaskRecord | null> {
    return this.#exclusive(async (document) => {
      const task = document.tasks.find(candidate => candidate.status === 'running')
      if (!task) return null
      const timestamp = now()
      task.status = 'failed'
      task.updatedAt = timestamp
      task.finishedAt = timestamp
      task.error = reason.trim() || 'cancelled_by_player'
      task.lastTransitionReason = reason.trim() || 'cancelled_by_player'
      delete task.result
      document.updatedAt = timestamp
      await this.#file.save(document)
      return taskCopy(task)
    })
  }

  async #finish(id: string, status: 'completed' | 'failed', detail: string): Promise<TaskRecord> {
    return this.#exclusive(async (document) => {
      const task = requireTask(document, id)
      if (task.status !== 'running') throw new Error(`任务 ${id} 当前状态 ${task.status}，不能标记为 ${status}`)
      const timestamp = now()
      task.status = status
      task.updatedAt = timestamp
      task.finishedAt = timestamp
      if (status === 'completed') {
        if (detail.trim()) task.result = detail.trim()
        delete task.error
      } else {
        task.error = detail.trim()
        delete task.result
      }
      document.updatedAt = timestamp
      await this.#file.save(document)
      return taskCopy(task)
    })
  }

  #selectNearestPlayerTask(queued: TaskRecord[], resolveDistance: PlayerDistanceResolver): TaskRecord | undefined {
    const groups = new Map<string, TaskRecord[]>()
    for (const task of queued) {
      if (task.source === 'webui_admin' || this.#isOwner(task.issuer)) continue
      const key = issuerKey(task.issuer)
      const group = groups.get(key)
      if (group) group.push(task)
      else groups.set(key, [task])
    }

    const selectedGroup = [...groups.entries()]
      .map(([key, tasks]) => ({
        key,
        tasks,
        distance: normalizedDistance(resolveDistance(tasks[0]!.issuer)),
        firstSequence: Math.min(...tasks.map((task) => task.sequence))
      }))
      .sort((left, right) => left.distance - right.distance || left.firstSequence - right.firstSequence || left.key.localeCompare(right.key))[0]
    return selectedGroup?.tasks.sort(compareWithinIssuer)[0]
  }

  #isOwner(issuer: TaskIssuer): boolean { return issuer.name.trim().toLowerCase() === this.#ownerName }

  #transitionToRunning(task: TaskRecord): void {
    const timestamp = now()
    task.status = 'running'
    task.startedAt = timestamp
    task.updatedAt = timestamp
    task.attempts++
    delete task.finishedAt
    delete task.result
  }

  async #initialize(): Promise<void> {
    if (this.#initialization) return this.#initialization
    this.#initialization = (async () => {
      const document = await this.#file.load()
      validateDocument(document)
      const running = document.tasks.filter((task) => task.status === 'running')
      if (running.length === 0) return
      const timestamp = now()
      for (const task of running) {
        task.status = 'queued'
        task.updatedAt = timestamp
        task.requeueCount++
        task.lastTransitionReason = 'startup_recovery'
        delete task.startedAt
        delete task.finishedAt
      }
      document.updatedAt = timestamp
      await this.#file.save(document)
    })()
    return this.#initialization
  }

  async #exclusive<T>(operation: (document: TaskDocument) => Promise<T>): Promise<T> {
    const result = this.#operationChain.then(async () => {
      await this.#initialize()
      const document = await this.#file.load()
      validateDocument(document)
      return operation(document)
    })
    this.#operationChain = result.then(() => undefined, () => undefined)
    return result
  }
}
