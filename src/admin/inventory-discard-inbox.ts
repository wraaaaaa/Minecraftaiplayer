import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseJsonDocument } from '../core/json.js'
import { resolveUserData } from '../core/user-data.js'

export type InventoryDiscardStatus = 'pending' | 'processing' | 'done' | 'error'

export interface InventoryDiscardSlot { slot: number; count: number }
export interface InventoryDiscard {
  id: string
  slots: InventoryDiscardSlot[]
  forceValuable?: boolean
  status: InventoryDiscardStatus
  createdAt: string
  updatedAt: string
  result?: string
}

function validateSlot(slot: InventoryDiscardSlot): InventoryDiscardSlot {
  if (!slot || typeof slot !== 'object') throw new Error('丢弃槽位无效')
  const index = Number(slot.slot)
  const count = Number(slot.count)
  if (!Number.isInteger(index) || index < 0 || index > 35) throw new Error('丢弃槽位编号无效（0-35）')
  if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error('丢弃数量无效（1-64）')
  return { slot: index, count }
}

function validate(command: InventoryDiscard): InventoryDiscard {
  if (!command || typeof command !== 'object' || typeof command.id !== 'string' || !Array.isArray(command.slots) || command.slots.length === 0) throw new Error('丢弃指令文件无效')
  if (!['pending', 'processing', 'done', 'error'].includes(command.status)) throw new Error('丢弃指令状态无效')
  return command
}

/** 跨进程收件箱：仪表盘背包整理请求，每条指令一个原子重命名文件，避免 JSON 竞争。 */
export class InventoryDiscardInbox {
  readonly directory: string

  constructor(directory = 'data/inventory-discard-inbox') { this.directory = resolveUserData(directory) }

  async initialize(): Promise<void> {
    await this.#ensureDirectory()
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith('.processing.json')) continue
      const source = path.join(this.directory, name)
      await rename(source, path.join(this.directory, name.replace(/\.processing\.json$/u, '.pending.json'))).catch(() => undefined)
    }
  }

  async submit(slots: InventoryDiscardSlot[], forceValuable = false): Promise<InventoryDiscard> {
    if (!Array.isArray(slots) || slots.length === 0) throw new Error('丢弃槽位不能为空')
    const clean = slots.map(validateSlot)
    await this.#ensureDirectory()
    const at = new Date().toISOString()
    const command: InventoryDiscard = { id: `${Date.now().toString(36).padStart(10, '0')}-${randomUUID()}`, slots: clean, forceValuable, status: 'pending', createdAt: at, updatedAt: at }
    const temporary = path.join(this.directory, `.${command.id}.tmp`)
    const target = this.#file(command.id, 'pending')
    await writeFile(temporary, `${JSON.stringify(command, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, target)
    return structuredClone(command)
  }

  async claimNext(): Promise<InventoryDiscard | null> {
    await this.#ensureDirectory()
    const candidates = (await readdir(this.directory)).filter(name => name.endsWith('.pending.json')).sort()
    for (const name of candidates) {
      const source = path.join(this.directory, name)
      const target = path.join(this.directory, name.replace(/\.pending\.json$/u, '.processing.json'))
      try { await rename(source, target) } catch { continue }
      const command = validate(parseJsonDocument<InventoryDiscard>(await readFile(target, 'utf8')))
      command.status = 'processing'; command.updatedAt = new Date().toISOString()
      await writeFile(target, `${JSON.stringify(command, null, 2)}\n`, 'utf8')
      return command
    }
    return null
  }

  async finish(command: InventoryDiscard, ok: boolean, result: string): Promise<void> {
    const source = this.#file(command.id, 'processing')
    const status: InventoryDiscardStatus = ok ? 'done' : 'error'
    const finished: InventoryDiscard = { ...command, status, result: result.slice(0, 4000), updatedAt: new Date().toISOString() }
    await writeFile(source, `${JSON.stringify(finished, null, 2)}\n`, 'utf8')
    await rename(source, this.#file(command.id, status))
  }

  #file(id: string, status: InventoryDiscardStatus): string { return path.join(this.directory, `${id}.${status}.json`) }
  async #ensureDirectory(): Promise<void> { await mkdir(this.directory, { recursive: true }) }
}
