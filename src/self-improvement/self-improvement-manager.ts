import { createHash, randomUUID } from 'node:crypto'
import type { AgentWorkspaceConfig } from '../config/types.js'
import { AtomicJsonFile } from '../core/atomic-json-file.js'
import type { LlmProvider } from '../llm/types.js'
import type { AgentAction } from '../policy/policy-engine.js'
import type { PromptDocumentName, PromptWorkspace } from '../prompts/prompt-workspace.js'
import type { SecretGuard } from '../security/secret-guard.js'

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
}
