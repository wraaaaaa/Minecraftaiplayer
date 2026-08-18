import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { projectPath, resolveUserData } from '../core/user-data.js'
import type { Persona } from '../config/types.js'
import type { PlayerIdentity, PlayerMemory } from '../memory/memory-store.js'

export const PROMPT_DOCUMENTS = ['rules.md', 'IDENTITY.md', 'SOUL.md', 'TOOLS.md', 'MEMORY.md'] as const
export type PromptDocumentName = typeof PROMPT_DOCUMENTS[number]
export type PromptDocuments = Record<PromptDocumentName, string>

export interface PlayerProfileDocument {
  id: string
  playerName: string
  uuid?: string
  content: string
  file: string
}

export interface BehaviorPatch {
  id: string
  createdAt: string
  failureSignature: string
  actionType: string
  errorPattern: string
  strategies: string[]
  researchSources: string[]
  enabled: boolean
}

export interface LearnedSkillStep {
  tool: string
  argsHint: string
  expect: string
}

export interface LearnedSkill {
  id: string
  name: string
  description: string
  whenToUse: string
  steps: LearnedSkillStep[]
  createdAt: string
  enabled: boolean
}

interface BehaviorPatchDocument {
  schemaVersion: 1
  updatedAt: string
  patches: BehaviorPatch[]
  skills?: LearnedSkill[]
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

async function exists(file: string): Promise<boolean> {
  try { await readFile(file); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function atomicText(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  const backup = `${file}.bak`
  await writeFile(temporary, content.endsWith('\n') ? content : `${content}\n`, 'utf8')
  try { await copyFile(file, backup) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await rename(temporary, file)
  } catch (error) {
    if (process.platform !== 'win32') throw error
    await rm(file, { force: true })
    await rename(temporary, file)
  }
}

function limitedMarkdown(value: string, name: string, maximum = 128_000): string {
  const normalized = value.replaceAll('\u0000', '').trim()
  if (!normalized) throw new Error(`${name} 不能为空`)
  if (normalized.length > maximum) throw new Error(`${name} 超过 ${maximum} 字符限制`)
  return `${normalized}\n`
}

function identityKey(identity: PlayerIdentity): string {
  return identity.uuid?.trim() ? `uuid:${identity.uuid.toLowerCase()}` : `name:${identity.name.toLowerCase()}`
}

function profileId(identity: PlayerIdentity): string {
  if (identity.uuid?.trim()) return `uuid-${identity.uuid.toLowerCase().replace(/[^a-z0-9-]/gu, '')}`
  const safeName = identity.name.toLowerCase().replace(/[^a-z0-9_]/gu, '_').slice(0, 32)
  return `name-${safeName || 'unknown'}`
}

function replaceManaged(content: string, start: string, end: string, body: string): string {
  const begin = content.indexOf(start)
  const finish = content.indexOf(end)
  if (begin < 0 || finish < begin) return `${content.trim()}\n\n${start}\n${body.trim()}\n${end}\n`
  return `${content.slice(0, begin + start.length)}\n${body.trim()}\n${content.slice(finish)}`
}

function appendSectionBullet(content: string, heading: string, value: string): string {
  if (content.split(/\r?\n/gu).some(line => line.trim() === `- ${value}`)) return content
  const start = content.indexOf(heading)
  if (start < 0) return `${content.trim()}\n\n${heading}\n\n- ${value}\n`
  const bodyStart = start + heading.length
  const next = content.indexOf('\n## ', bodyStart)
  const end = next < 0 ? content.length : next
  const section = content.slice(bodyStart, end).replace(/\n暂无。?\s*/gu, '\n')
  return `${content.slice(0, bodyStart)}${section.trimEnd()}\n\n- ${value}\n${content.slice(end)}`
}

const BOT_ALIAS_HEADING = '## 该玩家对 AI 的称呼'

function normalizeBotAlias(value: string): string | undefined {
  const normalized = value
    .replace(/^[\s`'"“”‘’「」『』]+|[\s`'"“”‘’「」『』，。！？!?：:；;、]+$/gu, '')
    .replace(/(?:吧|呀|啦|喽|哦)$/u, '')
    .trim()
  if (!normalized || normalized.length > 24 || /[\r\n<>]/u.test(normalized)) return undefined
  return normalized
}

export function extractBotAliases(content: string): string[] {
  const start = content.indexOf(BOT_ALIAS_HEADING)
  if (start < 0) return []
  const bodyStart = start + BOT_ALIAS_HEADING.length
  const next = content.indexOf('\n## ', bodyStart)
  const section = content.slice(bodyStart, next < 0 ? content.length : next)
  const aliases = section.split(/\r?\n/gu).flatMap(line => {
    const bullet = line.match(/^\s*[-*]\s+(.+)$/u)?.[1]
    if (!bullet || /^(?:暂无|没有|未设置)/u.test(bullet)) return []
    return bullet.split(/[，,、；;\/]/gu).flatMap(item => normalizeBotAlias(item) ?? [])
  })
  return [...new Set(aliases)].slice(0, 32)
}

export function extractDeclaredBotAlias(message: string): string | undefined {
  const captured = message.match(/(?:以后|今后)?\s*(?:我)?\s*(?:就)?\s*(?:叫你|喊你|称呼你|管你叫)\s*[`'"“‘「『]?([^\s，。！？!?：:；;、`'"”’」』]{1,28})/u)?.[1]
  return captured ? normalizeBotAlias(captured) : undefined
}

function ensureBotAliasSection(content: string): string {
  if (content.includes(BOT_ALIAS_HEADING)) return content
  const insertAt = content.indexOf('\n## 玩家明确表达的稳定事实')
  const section = `\n${BOT_ALIAS_HEADING}\n\n暂无。\n`
  return insertAt < 0 ? `${content.trim()}${section}` : `${content.slice(0, insertAt)}${section}${content.slice(insertAt)}`
}

function compactToolsDocument(content: string): string {
  const skipped = new Set(['## 原子接口', '## 连续技能'])
  const output: string[] = []
  let omitting = false
  for (const line of content.split(/\r?\n/gu)) {
    if (skipped.has(line.trim())) { omitting = true; continue }
    if (omitting && line.startsWith('## ')) omitting = false
    if (!omitting) output.push(line)
  }
  return output.join('\n').replace(/\n{3,}/gu, '\n\n').trim()
}

export class PromptWorkspace {
  readonly #root: string
  readonly #profileRoot: string
  readonly #exampleRoot: string
  readonly #allowedRoot: string

  constructor(options: { promptDirectory: string; playerProfilesDirectory: string; exampleDirectory?: string; allowedRoot?: string }) {
    this.#root = resolveUserData(options.promptDirectory)
    this.#profileRoot = resolveUserData(options.playerProfilesDirectory)
    this.#exampleRoot = projectPath(options.exampleDirectory ?? 'config/agent-prompts.example')
    this.#allowedRoot = resolveUserData(options.allowedRoot ?? 'data')
    if (!inside(this.#allowedRoot, this.#root) || !inside(this.#allowedRoot, this.#profileRoot)) {
      throw new Error('运行时提示词与玩家画像必须位于项目 userdata 目录内')
    }
  }

  get directory(): string { return this.#root }
  get playerProfilesDirectory(): string { return this.#profileRoot }

  async initialize(): Promise<void> {
    await Promise.all([mkdir(this.#root, { recursive: true }), mkdir(this.#profileRoot, { recursive: true })])
    for (const name of [...PROMPT_DOCUMENTS, 'behavior-patches.json'] as const) {
      const target = path.join(this.#root, name)
      if (!(await exists(target))) await copyFile(path.join(this.#exampleRoot, name), target)
    }
  }

  async readDocuments(): Promise<PromptDocuments> {
    await this.initialize()
    const entries = await Promise.all(PROMPT_DOCUMENTS.map(async name => [name, await readFile(path.join(this.#root, name), 'utf8')] as const))
    return Object.fromEntries(entries) as PromptDocuments
  }

  async writeDocuments(value: Partial<PromptDocuments>): Promise<void> {
    await this.initialize()
    for (const name of PROMPT_DOCUMENTS) {
      const content = value[name]
      if (content !== undefined) await atomicText(path.join(this.#root, name), limitedMarkdown(content, name))
    }
  }

  async ensurePlayerProfile(identity: PlayerIdentity, memory?: PlayerMemory): Promise<PlayerProfileDocument> {
    await this.initialize()
    const id = profileId(identity)
    const directory = path.join(this.#profileRoot, id)
    const file = path.join(directory, 'USER.md')
    if (!(await exists(file))) {
      const template = await readFile(path.join(this.#exampleRoot, 'USER.md'), 'utf8')
      const content = template
        .replaceAll('{{playerName}}', identity.name)
        .replaceAll('{{playerUuid}}', identity.uuid ?? '未提供')
        .replaceAll('{{playerKey}}', memory?.key ?? identityKey(identity))
        .replaceAll('{{createdAt}}', memory?.firstSeenAt ?? new Date().toISOString())
      await atomicText(file, content)
    }
    let content = await readFile(file, 'utf8')
    const migrated = ensureBotAliasSection(content)
    if (migrated !== content) {
      await atomicText(file, migrated)
      content = migrated
    }
    return { id, playerName: identity.name, ...(identity.uuid ? { uuid: identity.uuid } : {}), content, file }
  }

  async botAliases(identity: PlayerIdentity): Promise<string[]> {
    return extractBotAliases((await this.ensurePlayerProfile(identity)).content)
  }

  async appendBotAlias(identity: PlayerIdentity, alias: string): Promise<void> {
    const safe = normalizeBotAlias(alias)
    if (!safe) return
    const profile = await this.ensurePlayerProfile(identity)
    await atomicText(profile.file, appendSectionBullet(profile.content, BOT_ALIAS_HEADING, safe))
  }

  async listPlayerProfiles(): Promise<PlayerProfileDocument[]> {
    await this.initialize()
    const directories = await readdir(this.#profileRoot, { withFileTypes: true })
    const profiles: PlayerProfileDocument[] = []
    for (const entry of directories) {
      if (!entry.isDirectory() || !/^(?:uuid|name)-[a-z0-9_-]+$/u.test(entry.name)) continue
      const file = path.join(this.#profileRoot, entry.name, 'USER.md')
      if (!(await exists(file))) continue
      const content = await readFile(file, 'utf8')
      const playerName = content.match(/^- 玩家名：`([^`]+)`/mu)?.[1] ?? entry.name
      const uuid = content.match(/^- UUID：`([^`]+)`/mu)?.[1]
      profiles.push({ id: entry.name, playerName, ...(uuid && uuid !== '未提供' ? { uuid } : {}), content, file })
    }
    return profiles.sort((left, right) => left.playerName.localeCompare(right.playerName, 'zh-CN'))
  }

  async writePlayerProfile(id: string, content: string): Promise<PlayerProfileDocument> {
    if (!/^(?:uuid|name)-[a-z0-9_-]+$/u.test(id)) throw new Error('玩家画像 ID 无效')
    const file = path.resolve(this.#profileRoot, id, 'USER.md')
    if (!inside(this.#profileRoot, file)) throw new Error('玩家画像路径越界')
    await atomicText(file, limitedMarkdown(content, 'USER.md', 64_000))
    const saved = await readFile(file, 'utf8')
    const playerName = saved.match(/^- 玩家名：`([^`]+)`/mu)?.[1] ?? id
    const uuid = saved.match(/^- UUID：`([^`]+)`/mu)?.[1]
    return { id, playerName, ...(uuid && uuid !== '未提供' ? { uuid } : {}), content: saved, file }
  }

  async appendPlayerFact(identity: PlayerIdentity, fact: string, memory?: PlayerMemory): Promise<void> {
    const profile = await this.ensurePlayerProfile(identity, memory)
    const safe = fact.replace(/[\r\n]+/gu, ' ').trim().slice(0, 500)
    if (!safe) return
    await atomicText(profile.file, appendSectionBullet(profile.content, '## 玩家明确表达的稳定事实', safe))
  }

  async updateAutoProfile(identity: PlayerIdentity, markdown: string, memory?: PlayerMemory): Promise<void> {
    const profile = await this.ensurePlayerProfile(identity, memory)
    const safe = markdown.replaceAll('\u0000', '').trim().slice(0, 8_000)
    const body = `## 自动压缩画像\n\n${safe || '没有足够证据更新画像。'}`
    await atomicText(profile.file, replaceManaged(profile.content, '<!-- AUTO_PROFILE_START -->', '<!-- AUTO_PROFILE_END -->', body))
  }

  async appendLearnedToolGuidance(guidance: string): Promise<void> {
    const documents = await this.readDocuments()
    const current = documents['TOOLS.md']
    const managed = current.match(/<!-- AI_LEARNED_START -->([\s\S]*?)<!-- AI_LEARNED_END -->/u)?.[1] ?? ''
    const entries = managed.split(/\r?\n/u).map(line => line.trim()).filter(line => line.startsWith('- '))
    const next = `- ${guidance.replace(/[\r\n]+/gu, ' ').trim().slice(0, 1_000)}`
    if (!entries.includes(next)) entries.push(next)
    const body = `## AI 自动学习区\n\n${entries.slice(-24).join('\n') || '暂无已验证的自动学习规则。'}`
    await atomicText(path.join(this.#root, 'TOOLS.md'), replaceManaged(current, '<!-- AI_LEARNED_START -->', '<!-- AI_LEARNED_END -->', body))
  }

  async readBehaviorPatches(): Promise<BehaviorPatchDocument> {
    await this.initialize()
    const parsed = JSON.parse(await readFile(path.join(this.#root, 'behavior-patches.json'), 'utf8')) as BehaviorPatchDocument
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.patches)) throw new Error('behavior-patches.json 格式无效')
    return parsed
  }

  async addBehaviorPatch(patch: BehaviorPatch): Promise<void> {
    const document = await this.readBehaviorPatches()
    const existing = document.patches.findIndex(item => item.failureSignature === patch.failureSignature)
    if (existing >= 0) document.patches[existing] = patch
    else document.patches.push(patch)
    document.patches = document.patches.slice(-100)
    document.updatedAt = new Date().toISOString()
    await atomicText(path.join(this.#root, 'behavior-patches.json'), `${JSON.stringify(document, null, 2)}\n`)
  }

  async readLearnedSkills(): Promise<LearnedSkill[]> {
    return (await this.readBehaviorPatches()).skills ?? []
  }

  async addLearnedSkill(skill: LearnedSkill): Promise<void> {
    const document = await this.readBehaviorPatches()
    const skills = document.skills ?? []
    const existing = skills.findIndex(item => item.name.trim().toLowerCase() === skill.name.trim().toLowerCase())
    if (existing >= 0) skills[existing] = skill
    else skills.push(skill)
    document.skills = skills.slice(-60)
    document.updatedAt = new Date().toISOString()
    await atomicText(path.join(this.#root, 'behavior-patches.json'), `${JSON.stringify(document, null, 2)}\n`)
  }

  async buildSystemPrompt(persona: Persona, identity?: PlayerIdentity, options: { toolAgent?: boolean; ownerName?: string } = {}): Promise<string> {
    const documents = await this.readDocuments()
    const profile = identity ? await this.ensurePlayerProfile(identity) : undefined
    const patchDocument = await this.readBehaviorPatches()
    const patches = patchDocument.patches.filter(patch => patch.enabled).slice(-20)
    const skills = (patchDocument.skills ?? []).filter(skill => skill.enabled).slice(-20)
    const substitute = (value: string) => value
      .replaceAll('{{name}}', persona.name)
      .replaceAll('{{description}}', persona.description)
      .replaceAll('{{speakingStyle}}', persona.speakingStyle)
      .replaceAll('{{goals}}', persona.goals.join('；'))
      .replaceAll('{{boundaries}}', persona.boundaries.join('；'))
      .replaceAll('{{owner}}', options.ownerName ?? 'admin')
    return [
      substitute(documents['rules.md']),
      substitute(documents['IDENTITY.md']),
      substitute(documents['SOUL.md']),
      substitute(options.toolAgent ? compactToolsDocument(documents['TOOLS.md']) : documents['TOOLS.md']),
      substitute(documents['MEMORY.md']),
      profile ? `# 当前玩家专属 USER.md\n\n${profile.content}` : '',
      patches.length > 0 ? `# 已验证的声明式行为补丁\n\n${JSON.stringify(patches, null, 2)}` : '',
      skills.length > 0 ? `# 已学会的可复用技能配方\n\n${JSON.stringify(skills, null, 2)}` : ''
    ].filter(Boolean).join('\n\n---\n\n')
  }
}
