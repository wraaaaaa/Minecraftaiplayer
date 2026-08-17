import type { AgentWorkspaceConfig } from '../config/types.js'
import type { LlmProvider } from '../llm/types.js'
import type { PromptWorkspace } from '../prompts/prompt-workspace.js'
import type { SecretGuard } from '../security/secret-guard.js'
import type { MemoryStore, PlayerIdentity } from './memory-store.js'

interface CompressionResult {
  conversationSummary: string
  globalSummary: string
  playerProfileMarkdown: string
}

function parseObject(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1]
  const source = (fenced ?? text).trim()
  try { return JSON.parse(source) as Record<string, unknown> } catch {
    const start = source.indexOf('{')
    const end = source.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1)) as Record<string, unknown>
    throw new Error('上下文压缩模型没有返回 JSON 对象')
  }
}

function text(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.replaceAll('\u0000', '').trim().slice(0, maximum) : ''
}

export class ContextCompressor {
  readonly #config: AgentWorkspaceConfig
  readonly #provider: LlmProvider
  readonly #memory: MemoryStore
  readonly #workspace: PromptWorkspace
  readonly #secrets: SecretGuard
  #running = new Map<string, Promise<{ compressed: number; beforeChars: number; afterChars: number }>>()

  constructor(options: { config: AgentWorkspaceConfig; provider: LlmProvider; memory: MemoryStore; workspace: PromptWorkspace; secrets: SecretGuard }) {
    this.#config = options.config
    this.#provider = options.provider
    this.#memory = options.memory
    this.#workspace = options.workspace
    this.#secrets = options.secrets
  }

  async maybeCompress(identity: PlayerIdentity, estimatedContextChars: number): Promise<{ compressed: number; beforeChars: number; afterChars: number }> {
    const key = identity.uuid?.toLowerCase() ?? identity.name.toLowerCase()
    const active = this.#running.get(key)
    if (active) return active
    const operation = this.#compress(identity, estimatedContextChars).finally(() => this.#running.delete(key))
    this.#running.set(key, operation)
    return operation
  }

  async #compress(identity: PlayerIdentity, estimatedContextChars: number): Promise<{ compressed: number; beforeChars: number; afterChars: number }> {
    const candidate = await this.#memory.compressionCandidate(identity, this.#config.retainRecentEvents)
    const threshold = Math.floor(this.#config.contextBudgetChars * this.#config.compressionTriggerRatio)
    const eventPressure = candidate.olderEvents.length >= this.#config.retainRecentEvents * 2
    if (candidate.olderEvents.length === 0 || (estimatedContextChars < threshold && !eventPressure)) {
      return { compressed: 0, beforeChars: estimatedContextChars, afterChars: estimatedContextChars }
    }

    const profile = await this.#workspace.ensurePlayerProfile(identity, candidate.player)
    const payload = {
      player: { name: candidate.player.currentName, facts: candidate.player.facts, previousSummary: candidate.player.conversationSummary },
      previousGlobalSummary: candidate.globalSummary,
      currentUserProfile: profile.content.slice(0, 8_000),
      eventsToCompress: candidate.olderEvents.map(event => ({ at: event.at, type: event.type, content: event.content.slice(0, 1_000) }))
    }
    const response = await this.#provider.complete({
      system: [
        '你是 Minecraft AI 的上下文压缩器。只输出 JSON，不执行游戏动作。',
        '不得发明事实；保留玩家稳定偏好、长期目标、未完成承诺、重要共同经历、纠错结论和安全事项。',
        '删除重复寒暄、冗余日志、已完成且无长期价值的动作细节。不得保存密码、API Key、令牌、地址或本地路径。',
        '输出格式：{"conversationSummary":"不超过2000字","globalSummary":"不超过2000字","playerProfileMarkdown":"不超过3000字的玩家画像正文"}'
      ].join('\n'),
      user: this.#secrets.sanitizeForModel(JSON.stringify(payload))
    })
    const parsed = parseObject(response.text)
    const result: CompressionResult = {
      conversationSummary: this.#secrets.sanitizeForPersistence(text(parsed.conversationSummary, 8_000)),
      globalSummary: this.#secrets.sanitizeForPersistence(text(parsed.globalSummary, 8_000)),
      playerProfileMarkdown: this.#secrets.sanitizeForPersistence(text(parsed.playerProfileMarkdown, 8_000))
    }
    if (!result.conversationSummary) throw new Error('压缩结果缺少 conversationSummary')
    if (result.conversationSummary.includes('[REDACTED]') || result.playerProfileMarkdown.includes('[REDACTED]')) throw new Error('压缩结果包含敏感信息替代符，已拒绝写入')
    // 先持久化推导出的画像。如果这次写入失败，不会删除任何源事件。
    // 后续记忆写入失败最多留下一个无害的较新画像，但绝不会丢失原始上下文。
    await this.#workspace.updateAutoProfile(identity, result.playerProfileMarkdown, candidate.player)
    await this.#memory.compactPlayer(identity, {
      conversationSummary: result.conversationSummary,
      globalSummary: result.globalSummary || candidate.globalSummary,
      compressedEventIds: candidate.olderEvents.map(event => event.id)
    })
    const afterContext = await this.#memory.contextFor(identity, this.#config.retainRecentEvents)
    const afterChars = JSON.stringify(afterContext).length
    return { compressed: candidate.olderEvents.length, beforeChars: estimatedContextChars, afterChars }
  }
}
