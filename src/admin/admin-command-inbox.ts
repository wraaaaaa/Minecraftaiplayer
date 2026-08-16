import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseJsonDocument } from '../core/json.js'
import { resolveUserData } from '../core/user-data.js'

export type AdminCommandStatus = 'pending' | 'processing' | 'done' | 'error'

export interface AdminCommand {
  id: string
  message: string
  status: AdminCommandStatus
  createdAt: string
  updatedAt: string
  result?: string
}

function validate(command: AdminCommand): AdminCommand {
  if (!command || typeof command !== 'object' || typeof command.id !== 'string' || typeof command.message !== 'string') throw new Error('管理指令文件无效')
  if (!['pending', 'processing', 'done', 'error'].includes(command.status)) throw new Error('管理指令状态无效')
  return command
}

/** Cross-process inbox: every command owns one atomically-renamed file, avoiding JSON races. */
export class AdminCommandInbox {
  readonly directory: string

  constructor(directory = 'data/admin-inbox') { this.directory = resolveUserData(directory) }

  async initialize(): Promise<void> {
    await this.#ensureDirectory()
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith('.processing.json')) continue
      const source = path.join(this.directory, name)
      await rename(source, path.join(this.directory, name.replace(/\.processing\.json$/u, '.pending.json'))).catch(() => undefined)
    }
  }

  async submit(message: string): Promise<AdminCommand> {
    const clean = message.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim().slice(0, 1000)
    if (!clean) throw new Error('管理指令不能为空')
    await this.#ensureDirectory()
    const at = new Date().toISOString()
    const command: AdminCommand = { id: `${Date.now().toString(36).padStart(10, '0')}-${randomUUID()}`, message: clean, status: 'pending', createdAt: at, updatedAt: at }
    const temporary = path.join(this.directory, `.${command.id}.tmp`)
    const target = this.#file(command.id, 'pending')
    await writeFile(temporary, `${JSON.stringify(command, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, target)
    return structuredClone(command)
  }

  async claimNext(): Promise<AdminCommand | null> {
    await this.#ensureDirectory()
    const candidates = (await readdir(this.directory)).filter(name => name.endsWith('.pending.json')).sort()
    for (const name of candidates) {
      const source = path.join(this.directory, name)
      const target = path.join(this.directory, name.replace(/\.pending\.json$/u, '.processing.json'))
      try { await rename(source, target) } catch { continue }
      const command = validate(parseJsonDocument<AdminCommand>(await readFile(target, 'utf8')))
      command.status = 'processing'; command.updatedAt = new Date().toISOString()
      await writeFile(target, `${JSON.stringify(command, null, 2)}\n`, 'utf8')
      return command
    }
    return null
  }

  async finish(command: AdminCommand, ok: boolean, result: string): Promise<void> {
    const source = this.#file(command.id, 'processing')
    const status: AdminCommandStatus = ok ? 'done' : 'error'
    const finished: AdminCommand = { ...command, status, result: result.slice(0, 4000), updatedAt: new Date().toISOString() }
    await writeFile(source, `${JSON.stringify(finished, null, 2)}\n`, 'utf8')
    await rename(source, this.#file(command.id, status))
  }

  #file(id: string, status: AdminCommandStatus): string { return path.join(this.directory, `${id}.${status}.json`) }
  async #ensureDirectory(): Promise<void> { await mkdir(this.directory, { recursive: true }) }
}
