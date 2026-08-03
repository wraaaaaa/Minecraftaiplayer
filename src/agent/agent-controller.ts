import type { BotConfig, Persona } from '../config/types.js'
import type { Logger } from '../core/logger.js'
import type { ExperienceStore } from '../experience/experience-store.js'
import type { LlmProvider } from '../llm/types.js'
import type { MemoryStore, PlayerIdentity } from '../memory/memory-store.js'
import type { AgentAction, PolicyEngine } from '../policy/policy-engine.js'
import { parseAgentDecision } from './decision.js'
import { buildPlayerRequest, buildSystemPrompt } from './prompt.js'
import type { WorldState } from './world-state.js'

export interface ActionExecutor {
  execute(action: AgentAction): Promise<{ ok: boolean; detail: string }>
  chat(message: string): Promise<void>
}

export class AgentController {
  readonly #config: BotConfig
  readonly #persona: Persona
  readonly #provider: LlmProvider
  readonly #memory: MemoryStore
  readonly #experience: ExperienceStore
  readonly #policy: PolicyEngine
  readonly #executor: ActionExecutor
  readonly #logger: Logger
  readonly #lastPlayerRequest = new Map<string, number>()
  #lastInboundAt = Date.now()
  #lastProactiveAt = 0

  constructor(options: { config: BotConfig; persona: Persona; provider: LlmProvider; memory: MemoryStore; experience: ExperienceStore; policy: PolicyEngine; executor: ActionExecutor; logger: Logger }) {
    this.#config = options.config
    this.#persona = options.persona
    this.#provider = options.provider
    this.#memory = options.memory
    this.#experience = options.experience
    this.#policy = options.policy
    this.#executor = options.executor
    this.#logger = options.logger
  }

  async handlePlayerMessage(identity: PlayerIdentity, message: string, world: WorldState): Promise<void> {
    this.#lastInboundAt = Date.now()
    const key = identity.uuid ?? identity.name.toLowerCase()
    const last = this.#lastPlayerRequest.get(key) ?? 0
    if (Date.now() - last < this.#config.chat.cooldownMs) return
    this.#lastPlayerRequest.set(key, Date.now())
    await this.#memory.recordPlayerMessage(identity, message)
    const context = await this.#memory.contextFor(identity)
    const experiences = await this.#experience.relevant(message)
    try {
      const response = await this.#provider.complete({
        system: buildSystemPrompt(this.#persona),
        user: buildPlayerRequest({ ...context, message, experiences, world })
      })
      const decision = parseAgentDecision(response.text)
      if (decision.remember && !/password|密码|api.?key|token|令牌|地址/iu.test(decision.remember)) await this.#memory.rememberFact(identity, decision.remember)
      const policy = this.#policy.authorize(decision.action)
      let actionResult = { ok: false, detail: policy.reason }
      if (policy.allowed) actionResult = await this.#executor.execute(decision.action)
      else this.#logger.warn('行为被策略拒绝', { player: identity.name, action: decision.action, reason: policy.reason })
      if (!actionResult.ok && decision.action.type !== 'none') {
        await this.#experience.add({ task: JSON.stringify(decision.action), context: message, outcome: 'failure', lesson: actionResult.detail, correction: '下次先核对状态与行为规则，再选择可执行动作。', tags: [decision.action.type] })
      }
      if (decision.reply) {
        const reply = `${this.#config.chat.replyPrefix}${decision.reply}`
        await this.#executor.chat(reply)
        await this.#memory.recordBotReply(identity, reply)
      }
      this.#logger.info('已处理玩家消息', { player: identity.name, model: response.model, requestedEffort: response.requestedEffort, effectiveEffort: response.effectiveEffort, action: decision.action.type, actionOk: actionResult.ok })
    } catch (error) {
      this.#logger.error('处理玩家消息失败', { player: identity.name, error })
      await this.#executor.chat(`${this.#config.chat.replyPrefix}我刚才处理失败了，稍后再试。`)
    }
  }

  async proactiveTick(world: WorldState): Promise<void> {
    const now = Date.now()
    if (!this.#config.chat.proactiveEnabled || !world.connected) return
    if (now - this.#lastInboundAt < this.#config.chat.proactiveIdleMs) return
    if (now - this.#lastProactiveAt < this.#config.chat.proactiveMinIntervalMs) return
    this.#lastProactiveAt = now
    try {
      const experiences = await this.#experience.relevant('空闲 自主 闲逛 聊天')
      const response = await this.#provider.complete({
        system: buildSystemPrompt(this.#persona),
        user: JSON.stringify({ mode: 'proactive_idle', instruction: '你已空闲一段时间。可以保持安静、发一句不打扰人的自然聊天，或进行半径不超过 8 格的非破坏性闲逛。不要假装完成采集或建造。', structuredGameState: world, relevantExperience: experiences })
      })
      const decision = parseAgentDecision(response.text)
      const safeAction: AgentAction = decision.action.type === 'wander' || decision.action.type === 'none' ? decision.action : { type: 'none' }
      const policy = this.#policy.authorize(safeAction)
      if (policy.allowed) await this.#executor.execute(safeAction)
      if (decision.reply) {
        const reply = `${this.#config.chat.replyPrefix}${decision.reply}`
        await this.#executor.chat(reply)
        await this.#memory.recordGameEvent(`Bot 空闲时主动发言：${reply}`)
      }
    } catch (error) {
      this.#logger.warn('主动空闲行为跳过', error)
    }
  }
}
