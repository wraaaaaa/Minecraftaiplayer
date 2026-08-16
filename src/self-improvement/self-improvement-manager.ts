import { createHash, randomUUID } from 'node:crypto'
import type { AgentWorkspaceConfig } from '../config/types.js'
import { AtomicJsonFile } from '../core/atomic-json-file.js'
import type { LlmProvider } from '../llm/types.js'
import type { AgentAction } from '../policy/policy-engine.js'
import type { LearnedSkill, PromptDocumentName, PromptWorkspace } from '../prompts/prompt-workspace.js'
import type { SecretGuard } from '../security/secret-guard.js'
import { AGENT_TOOLS } from '../agent/tool-agent.js'

interface FailureRecord {
  signature: string
  actionType: string
  normalizedError: string
  count: number
  firstAt: string
  lastAt: string
  lastResearchAt?: string
  lastGuidance?: string
}

interface ImprovementDocument {
  schemaVersion: 1
  updatedAt: string
  failures: Record<string, FailureRecord>
  lastSkillAt?: string
}

export interface SuccessStep {
  tool: string
  args: string
}

export interface ImprovementOutcome {
  status: 'recorded' | 'threshold_pending' | 'cooldown' | 'learned' | 'disabled' | 'rejected'
  signature?: string
  count?: number
  guidance?: string
  researchSources?: string[]
}

interface ResearchResult { source: string; title: string; snippet: string }

function now(): string { return new Date().toISOString() }

function normalizedError(value: string): string {
  return value
    .replace(/\b-?\d+(?:\.\d+)?\b/gu, '#')
    .replace(/[a-f0-9]{8,}/giu, '<id>')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 1_000)
}

function signature(actionType: string, detail: string): string {
  return createHash('sha256').update(`${actionType}\n${normalizedError(detail)}`).digest('hex').slice(0, 20)
}

function stripHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, '\n')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{2,}/gu, '\n')
    .trim()
}

function parseJsonObject(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1]
  const source = (fenced ?? text).trim()
  try { return JSON.parse(source) as Record<string, unknown> } catch {
    const start = source.indexOf('{')
    const end = source.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1)) as Record<string, unknown>
    throw new Error('自我改进模型没有返回 JSON 对象')
  }
}

function safeLearning(value: string): boolean {
  return !/(?:绕过|关闭|禁用|移除|删除).{0,12}(?:安全|规则|策略|验证|沙箱|脱敏)|(?:api\s*key|密码|令牌|本地路径|执行命令|powershell|cmd\.exe|下载并运行|eval\s*\()/iu.test(value)
}

export class SelfImprovementManager {
  readonly #config: AgentWorkspaceConfig['selfImprovement']
  readonly #provider: LlmProvider
  readonly #workspace: PromptWorkspace
  readonly #secrets: SecretGuard
  readonly #file: AtomicJsonFile<ImprovementDocument>

  constructor(options: { config: AgentWorkspaceConfig['selfImprovement']; provider: LlmProvider; workspace: PromptWorkspace; secrets: SecretGuard; file?: string }) {
    this.#config = options.config
    this.#provider = options.provider
    this.#workspace = options.workspace
    this.#secrets = options.secrets
    this.#file = new AtomicJsonFile(options.file ?? 'data/self-improvement.json', () => ({ schemaVersion: 1, updatedAt: now(), failures: {} }))
  }

  async initialize(): Promise<void> { await this.#file.load() }

  async research(query: string): Promise<ResearchResult[]> {
    const safeQuery = this.#secrets.sanitizeForModel(query).replace(/[\r\n]+/gu, ' ').trim().slice(0, 240)
    if (!safeQuery || safeQuery.includes('[REDACTED]') || this.#config.researchProvider === 'disabled') return []
    const endpoint = new URL(this.#config.researchEndpoint)
    if (this.#config.researchProvider === 'baidu') endpoint.searchParams.set('wd', safeQuery)
    else {
      endpoint.searchParams.set('q', safeQuery)
      endpoint.searchParams.set('format', 'json')
    }
    const response = await fetch(endpoint, {
      headers: { accept: this.#config.researchProvider === 'searxng' ? 'application/json' : 'text/html', 'user-agent': 'Minecraft-AI-Player/0.1 research' },
      signal: AbortSignal.timeout(this.#config.researchTimeoutMs)
    })
    if (!response.ok) throw new Error(`研究端点返回 HTTP ${response.status}`)
    const body = (await response.text()).slice(0, 256_000)
    if (this.#config.researchProvider === 'searxng') {
      const parsed = JSON.parse(body) as { results?: Array<{ title?: string; content?: string; url?: string }> }
      return (parsed.results ?? []).slice(0, 6).map(item => ({
        source: String(item.url ?? endpoint.origin).slice(0, 500),
        title: String(item.title ?? '搜索结果').slice(0, 200),
        snippet: String(item.content ?? '').replace(/\s+/gu, ' ').slice(0, 800)
      }))
    }
    const plain = stripHtml(body)
    const chunks = plain.split('\n').map(line => line.trim()).filter(line => line.length >= 24 && line.length <= 1_000)
    return chunks.slice(0, 6).map((snippet, index) => ({ source: endpoint.origin, title: `百度搜索摘要 ${index + 1}`, snippet }))
  }

  async learnFromFailure(input: { action: AgentAction; detail: string; taskContext: string }): Promise<ImprovementOutcome> {
    if (!this.#config.enabled) return { status: 'disabled' }
    const safeDetail = this.#secrets.sanitizeForPersistence(input.detail).slice(0, 4_000)
    if (!safeDetail || safeDetail.includes('[REDACTED]')) return { status: 'rejected' }
    const id = signature(input.action.type, safeDetail)
    const document = await this.#file.update(value => {
      const timestamp = now()
      const record = value.failures[id]
      value.failures[id] = record
        ? { ...record, count: record.count + 1, lastAt: timestamp }
        : { signature: id, actionType: input.action.type, normalizedError: normalizedError(safeDetail), count: 1, firstAt: timestamp, lastAt: timestamp }
      value.updatedAt = timestamp
    })
    const record = document.failures[id]!
    if (record.count < this.#config.minimumRepeatedFailures) return { status: 'threshold_pending', signature: id, count: record.count }
    if (record.lastResearchAt && Date.now() - Date.parse(record.lastResearchAt) < 6 * 60 * 60_000) return { status: 'cooldown', signature: id, count: record.count }

    let research: ResearchResult[] = []
    try {
      research = await this.research(`Minecraft 26.2 Fabric AI bot ${input.action.type} ${record.normalizedError}`)
    } catch {
      // Offline research is non-fatal. The model can still derive a bounded correction from local evidence.
    }
    const response = await this.#provider.complete({
      system: [
        '你是 Minecraft AI 的受限自我改进器，只输出 JSON。',
        '依据失败、现有白名单动作和研究摘要提出可验证修正。不得关闭安全、扩大权限、执行系统命令、下载代码或读取秘密。',
        '输出：{"guidance":"一条不超过500字的工具使用规则","strategies":["最多5条可验证替代步骤"]}'
      ].join('\n'),
      user: this.#secrets.sanitizeForModel(JSON.stringify({
        action: input.action,
        failure: safeDetail,
        taskContext: input.taskContext.slice(0, 1_000),
        research: research.map(item => ({ title: item.title, snippet: item.snippet, source: item.source }))
      }))
    })
    const parsed = parseJsonObject(response.text)
    const guidance = this.#secrets.sanitizeForPersistence(typeof parsed.guidance === 'string' ? parsed.guidance.replace(/\s+/gu, ' ').trim().slice(0, 1_000) : '')
    const strategies = Array.isArray(parsed.strategies)
      ? parsed.strategies.filter((item): item is string => typeof item === 'string').map(item => item.replace(/\s+/gu, ' ').trim().slice(0, 500)).filter(Boolean).slice(0, 5)
      : []
    if (!guidance || guidance.includes('[REDACTED]') || !safeLearning(`${guidance}\n${strategies.join('\n')}`)) {
      await this.#file.update(value => { value.failures[id]!.lastResearchAt = now(); value.updatedAt = now() })
      return { status: 'rejected', signature: id, count: record.count }
    }

    if (this.#config.allowPromptEdits) await this.#workspace.appendLearnedToolGuidance(guidance)
    const sources = research.map(item => item.source).filter((source, index, all) => all.indexOf(source) === index).slice(0, 6)
    if (this.#config.allowBehaviorPatches && strategies.length > 0) {
      await this.#workspace.addBehaviorPatch({
        id: randomUUID(), createdAt: now(), failureSignature: id, actionType: input.action.type,
        errorPattern: record.normalizedError, strategies, researchSources: sources, enabled: true
      })
    }
    await this.#file.update(value => {
      const latest = value.failures[id]!
      latest.lastResearchAt = now()
      latest.lastGuidance = guidance
      value.updatedAt = now()
    })
    return { status: 'learned', signature: id, count: record.count, guidance, researchSources: sources }
  }

  async ownerEdit(document: PromptDocumentName, content: string): Promise<void> {
    await this.#workspace.writeDocuments({ [document]: content })
  }

  async learnFromSuccess(input: { task: string; steps: SuccessStep[] }): Promise<ImprovementOutcome> {
    if (!this.#config.enabled || !this.#config.allowSkillLearning) return { status: 'disabled' }
    const successful = input.steps.filter(step => {
      if (typeof step.tool !== 'string' || typeof step.args !== 'string') return false
      const clean = step.tool.trim().toLowerCase()
      return clean && clean !== 'observe_world' && clean !== 'wait_ticks' && clean !== 'stop_all_actions'
    })
    if (successful.length < this.#config.minimumStepsForSkill) return { status: 'threshold_pending', count: successful.length }
    const document = await this.#file.load()
    if (document.lastSkillAt && Date.now() - Date.parse(document.lastSkillAt) < 30 * 60_000) return { status: 'cooldown' }

    const allowedTools = new Set([...AGENT_TOOLS.map(tool => tool.name), 'search_game_guide'])
    const safeTask = this.#secrets.sanitizeForModel(input.task).replace(/\s+/gu, ' ').trim().slice(0, 1_000)
    const safeSteps = successful.slice(-24).map(step => ({
      tool: step.tool,
      args: this.#secrets.sanitizeForModel(step.args).replace(/\s+/gu, ' ').trim().slice(0, 600)
    })).filter(step => step.args && !step.args.includes('[REDACTED]'))
    if (!safeTask || safeSteps.length === 0) return { status: 'rejected' }

    const response = await this.#provider.complete({
      system: [
        '你是 Minecraft AI 的受限技能提炼器，只输出 JSON。',
        '依据一次真实成功的任务过程，提炼一个“声明式技能配方”：把已成功执行的工具序列概括为可复用的步骤模板。',
        '硬边界：步骤里的 tool 只能使用白名单内已有工具名；不得发明新工具、不得包含代码/命令/密钥/本地路径/服务器地址、不得绕过任何安全规则。',
        `白名单工具：${[...allowedTools].join('、')}`,
        '输出：{"name":"技能名(<=48字)","description":"做什么(<=160字)","whenToUse":"何时用(<=160字)","steps":[{"tool":"白名单工具名","argsHint":"参数要点(<=160字)","expect":"成功判据(<=160字)"}]}'
      ].join('\n'),
      user: JSON.stringify({ task: safeTask, successSteps: safeSteps })
    })
    const parsed = parseJsonObject(response.text)
    const name = typeof parsed.name === 'string' ? parsed.name.replace(/\s+/gu, ' ').trim().slice(0, 48) : ''
    const description = typeof parsed.description === 'string' ? parsed.description.replace(/\s+/gu, ' ').trim().slice(0, 160) : ''
    const whenToUse = typeof parsed.whenToUse === 'string' ? parsed.whenToUse.replace(/\s+/gu, ' ').trim().slice(0, 160) : ''
    const steps = Array.isArray(parsed.steps)
      ? parsed.steps.slice(0, 8).flatMap(item => {
          if (!item || typeof item !== 'object') return []
          const tool = typeof (item as Record<string, unknown>).tool === 'string' ? (item as Record<string, unknown>).tool as string : ''
          if (!allowedTools.has(tool.trim().toLowerCase())) return []
          const argsHint = typeof (item as Record<string, unknown>).argsHint === 'string' ? (item as Record<string, unknown>).argsHint as string : ''
          const expect = typeof (item as Record<string, unknown>).expect === 'string' ? (item as Record<string, unknown>).expect as string : ''
          return [{ tool: tool.trim().toLowerCase(), argsHint: argsHint.replace(/\s+/gu, ' ').trim().slice(0, 160), expect: expect.replace(/\s+/gu, ' ').trim().slice(0, 160) }]
        })
      : []
    if (!name || !description || steps.length === 0) {
      await this.#file.update(value => { value.lastSkillAt = now(); value.updatedAt = now() })
      return { status: 'rejected' }
    }
    const combined = `${name}\n${description}\n${whenToUse}\n${steps.map(step => `${step.tool} ${step.argsHint} ${step.expect}`).join('\n')}`
    const safeSkill = this.#secrets.sanitizeForPersistence(combined)
    if (safeSkill.includes('[REDACTED]') || !safeLearning(safeSkill)) {
      await this.#file.update(value => { value.lastSkillAt = now(); value.updatedAt = now() })
      return { status: 'rejected' }
    }
    const skill: LearnedSkill = { id: randomUUID(), name, description, whenToUse, steps, createdAt: now(), enabled: true }
    await this.#workspace.addLearnedSkill(skill)
    await this.#file.update(value => { value.lastSkillAt = now(); value.updatedAt = now() })
    return { status: 'learned', signature: skill.id, count: steps.length, guidance: skill.name }
  }
}
