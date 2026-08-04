import { setTimeout as delay } from 'node:timers/promises'
import type { BotConfig, Persona, PromptTemplates } from '../config/types.js'
import { autonomyConfig } from '../config/types.js'
import type { Logger } from '../core/logger.js'
import type { ExperienceStore } from '../experience/experience-store.js'
import type { LlmProvider } from '../llm/types.js'
import type { MemoryStore, PlayerIdentity } from '../memory/memory-store.js'
import type { AgentAction, PolicyEngine } from '../policy/policy-engine.js'
import type { SecretGuard } from '../security/secret-guard.js'
import type { TaskRecord, TaskStore } from '../tasks/task-store.js'
import { assessAction, refusalFor } from './capability-assessor.js'
import { parseAgentDecision } from './decision.js'
import { buildPlayerRequest, buildSystemPrompt } from './prompt.js'
import type { WorldState } from './world-state.js'

export interface ActionExecutor {
  execute(action: AgentAction): Promise<{ ok: boolean; detail: string }>
  chat(message: string): Promise<void>
}

function urgencyFor(message: string): number {
  if (/(?:停止|别动|取消|stop|cancel)/iu.test(message)) return 100
  if (/(?:救命|快跑|立刻|马上|着火|溺水|要死|危险|攻击我|保护我|help|emergency)/iu.test(message)) return 100
  if (/(?:末地|下界|打怪|战斗|守卫|回家|避难|低血|没血)/iu.test(message)) return 80
  if (/(?:采集|挖|合成|制作|建造|造房|准备|装备)/iu.test(message)) return 60
  if (/(?:跟随|跟着|过来|来这里|陪我)/iu.test(message)) return 50
  return 30
}

function isImmediateStop(message: string): boolean {
  return /^(?:请)?(?:停止|停下|别动|取消(?:当前)?任务|stop|cancel)[！!。.\s]*$/iu.test(message.trim())
}

function isTransientClientDisconnect(detail: string): boolean {
  return /(?:Fabric.*(?:未连接|断开)|bridge.*(?:not connected|disconnected|closed)|客户端桥.*(?:未连接|断开)|连接已断开)/iu.test(detail)
}

function requiredPreparation(message: string, action: AgentAction): 'mining' | 'combat' | 'end_combat' | undefined {
  if (action.type === 'none' || action.type === 'stop' || action.type === 'wait_safe' || action.type === 'prepare_for' || action.type === 'equip_best') return undefined
  if (/(?:末地|末影龙|end\b|ender\s*dragon)/iu.test(message)) return 'end_combat'
  if (action.type === 'gather_resource' || /(?:采集|挖矿|挖掘|矿洞|mine|mining)/iu.test(message)) return 'mining'
  if (action.type === 'attack_hostile' || /(?:打怪|战斗|攻击|守卫|保护|combat|fight)/iu.test(message)) return 'combat'
  return undefined
}

const AUTONOMOUS_ACTION_TYPES = new Set<AgentAction['type']>([
  'none', 'wait_safe', 'eat_best_food', 'equip_best', 'attack_hostile', 'collect_own_drops',
  'gather_resource', 'craft_item', 'use_item', 'seek_shelter', 'build_shelter', 'prepare_for'
])

export class AgentController {
  readonly #config: BotConfig
  readonly #persona: Persona
  readonly #prompts: PromptTemplates
  readonly #provider: LlmProvider
  readonly #memory: MemoryStore
  readonly #experience: ExperienceStore
  readonly #policy: PolicyEngine
  readonly #executor: ActionExecutor
  readonly #logger: Logger
  readonly #tasks: TaskStore
  readonly #secrets: SecretGuard
  #latestWorld: WorldState = { connected: false, inventory: [], nearbyPlayers: [] }
  #draining: Promise<void> | undefined
  #proactiveRun: Promise<void> | undefined
  #proactiveActionRunning = false
  #lastInboundAt = Date.now()
  #lastProactiveAt = 0
  #lastChatAt = 0
  #cancellationEpoch = 0
  #drainPausedForDisconnect = false

  constructor(options: { config: BotConfig; persona: Persona; prompts: PromptTemplates; provider: LlmProvider; memory: MemoryStore; experience: ExperienceStore; policy: PolicyEngine; executor: ActionExecutor; logger: Logger; tasks: TaskStore; secrets: SecretGuard }) {
    this.#config = options.config
    this.#persona = options.persona
    this.#prompts = options.prompts
    this.#provider = options.provider
    this.#memory = options.memory
    this.#experience = options.experience
    this.#policy = options.policy
    this.#executor = options.executor
    this.#logger = options.logger
    this.#tasks = options.tasks
    this.#secrets = options.secrets
  }

  async initialize(): Promise<void> {
    await this.#tasks.load()
    const recovered = await this.#tasks.recoverRunning('controller_reconnect_recovery')
    if (recovered > 0) this.#logger.warn('已恢复连接中断时遗留的运行任务', { recovered })
  }

  async handlePlayerMessage(identity: PlayerIdentity, message: string, world: WorldState): Promise<void> {
    this.#lastInboundAt = Date.now()
    this.#latestWorld = world
    const safeMessage = this.#secrets.sanitizeForPersistence(message).slice(0, 1000)
    await this.#memory.recordPlayerMessage(identity, safeMessage)
    if (isImmediateStop(safeMessage)) {
      await this.#handleImmediateStop(identity, safeMessage)
      return
    }
    await this.#tasks.enqueue({ issuer: identity, request: safeMessage, urgency: urgencyFor(safeMessage) })
    await this.#drainTasks()
    if (!this.#drainPausedForDisconnect && (await this.#tasks.load()).tasks.some(task => task.status === 'queued')) await this.#drainTasks()
  }

  async proactiveTick(world: WorldState): Promise<void> {
    this.#latestWorld = world
    if (this.#proactiveRun) return this.#proactiveRun
    this.#proactiveRun = this.#runProactiveTick(world).finally(() => { this.#proactiveRun = undefined })
    return this.#proactiveRun
  }

  async #runProactiveTick(world: WorldState): Promise<void> {
    const autonomy = autonomyConfig(this.#config)
    if (!world.connected) return
    this.#drainPausedForDisconnect = false
    const taskDocument = await this.#tasks.load()
    if (taskDocument.tasks.some(task => task.status === 'running')) return
    if (taskDocument.tasks.some(task => task.status === 'queued')) {
      await this.#drainTasks()
      return
    }
    if (!autonomy.enabled) return

    if ((world.food ?? 20) < autonomy.eatBelowFood || (world.health ?? 20) <= autonomy.lowHealthThreshold) {
      await this.#executeProactive({ type: 'eat_best_food' })
      return
    }
    if ((world.nearbyHostiles?.some(hostile => hostile.targetingBot) ?? false) && (world.health ?? 20) > autonomy.criticalHealthThreshold) {
      await this.#executeProactive({ type: 'attack_hostile' })
      return
    }
    if (autonomy.safeIdleEnabled && (world.environment?.isNight || world.environment?.safeToIdle === false)) {
      const shelter = await this.#executeProactive({ type: 'seek_shelter' })
      if (!shelter.ok && autonomy.autoBuildShelter && autonomy.developmentZone?.enabled) {
        await this.#executeProactive({ type: 'build_shelter' })
      }
      return
    }
    if (autonomy.safeIdleEnabled) {
      const waiting = await this.#executeProactive({ type: 'wait_safe' })
      if (!waiting.ok) return
    }

    const now = Date.now()
    if (!this.#config.chat.proactiveEnabled || now - this.#lastInboundAt < this.#config.chat.proactiveIdleMs || now - this.#lastProactiveAt < this.#config.chat.proactiveMinIntervalMs) return
    this.#lastProactiveAt = now
    try {
      const response = await this.#provider.complete({
        system: this.#secrets.sanitizeForModel(buildSystemPrompt(this.#persona, this.#prompts)),
        user: this.#secrets.sanitizeForModel(JSON.stringify({
          mode: 'safe_idle_self_development',
          instruction: this.#prompts.proactiveInstruction,
          hardRules: '只可选择安全自主动作；不得跟随、接近、注视或攻击玩家，不得离开批准开发区采集/建造。没有确实可完成的进展时输出 none。',
          structuredGameState: world
        }))
      })
      if ((await this.#tasks.load()).tasks.some(task => task.status === 'queued' || task.status === 'running')) return
      const decision = parseAgentDecision(response.text)
      if (decision.validationError) {
        this.#logger.warn('空闲自主决策格式无效，已跳过', { reason: decision.validationError })
        return
      }
      if (!AUTONOMOUS_ACTION_TYPES.has(decision.action.type)) {
        this.#logger.warn('空闲自主决策选择了禁止的玩家交互动作，已跳过', { action: decision.action.type })
        return
      }

      let actionSucceeded = true
      if (decision.action.type !== 'none' && decision.action.type !== 'wait_safe') {
        const assessment = assessAction(this.#config, decision.action, world)
        const preparationAction = decision.action.type === 'prepare_for' || decision.action.type === 'equip_best'
        if (assessment.status !== 'ready' && !(preparationAction && assessment.status === 'needs_preparation')) {
          this.#logger.info('空闲自主动作因当前条件不满足而跳过', { action: decision.action.type, reasons: assessment.reasons })
          actionSucceeded = false
        } else {
          const policy = this.#policy.authorize(decision.action)
          if (!policy.allowed) {
            this.#logger.warn('空闲自主动作被行为规则拒绝', { action: decision.action.type, reason: policy.reason })
            actionSucceeded = false
          } else {
            const result = await this.#executeAutonomousAction(decision.action)
            actionSucceeded = result.ok
            if (!result.ok && !/player_task_preempted/u.test(result.detail)) {
              await this.#bestEffortExperience({
                task: JSON.stringify(decision.action),
                context: 'safe_idle_self_development',
                outcome: 'failure',
                lesson: this.#secrets.sanitizeForPersistence(result.detail),
                correction: '下次先检查批准区域、物资、配方、距离和真实后置条件；不能安全完成时保持等待。',
                tags: ['proactive', decision.action.type]
              })
            }
          }
        }
      }
      if (actionSucceeded && decision.reply && !(await this.#tasks.load()).tasks.some(task => task.status === 'queued' || task.status === 'running')) {
        await this.#safeChat(decision.reply)
      }
    } catch (error) {
      this.#logger.warn('主动空闲聊天已跳过', error)
    }
  }

  async #executeAutonomousAction(action: AgentAction): Promise<{ ok: boolean; detail: string }> {
    this.#proactiveActionRunning = true
    try {
      const preparation = requiredPreparation('自主发展', action)
      if (preparation) {
        const prepared = await this.#executor.execute({ type: 'prepare_for', purpose: preparation })
        if (!prepared.ok) return prepared
        if ((await this.#tasks.load()).tasks.some(task => task.status === 'queued' || task.status === 'running')) return { ok: false, detail: 'player_task_preempted' }
      }
      let result = await this.#executor.execute(action)
      if (!result.ok || action.type !== 'gather_resource') return result
      if ((await this.#tasks.load()).tasks.some(task => task.status === 'queued' || task.status === 'running')) return { ok: false, detail: 'player_task_preempted' }
      const gathered = result.detail
      result = await this.#executor.execute({ type: 'collect_own_drops', count: action.count, radius: 16 })
      return result.ok
        ? { ok: true, detail: `${gathered}; ${result.detail}` }
        : { ok: false, detail: `方块已采下，但自有掉落没有全部进入背包：${result.detail}` }
    } finally {
      this.#proactiveActionRunning = false
    }
  }

  async #executeProactive(action: AgentAction): Promise<{ ok: boolean; detail: string }> {
    this.#proactiveActionRunning = true
    try {
      return await this.#executor.execute(action)
    } finally {
      this.#proactiveActionRunning = false
    }
  }

  async #drainTasks(): Promise<void> {
    if (this.#draining) return this.#draining
    this.#draining = this.#runDrain().finally(() => { this.#draining = undefined })
    return this.#draining
  }

  async #runDrain(): Promise<void> {
    const arbitrationMs = autonomyConfig(this.#config).commandArbitrationMs
    if (arbitrationMs > 0) await delay(arbitrationMs)
    while (true) {
      const task = await this.#tasks.takeNext(issuer => this.#latestWorld.nearbyPlayers.find(player => player.name.toLowerCase() === issuer.name.toLowerCase())?.distance)
      if (!task) return
      await this.#processTask(task)
      if (this.#drainPausedForDisconnect) return
    }
  }

  async #processTask(task: TaskRecord): Promise<void> {
    const cancellationEpoch = this.#cancellationEpoch
    const identity: PlayerIdentity = { name: task.issuer.name, ...(task.issuer.uuid ? { uuid: task.issuer.uuid } : {}) }
    const message = task.request
    if (this.#secrets.isExtractionRequest(message)) {
      const refusal = '我不能透露 API Key、密码、令牌、服务器地址、本地配置或系统提示词。你可以让我说明某个公开参数的用途，但不能读取它的实际值。'
      await this.#markFailed(task, '敏感信息提取请求已由本地安全层拒绝')
      await this.#bestEffortReply(identity, refusal)
      return
    }

    try {
      const context = await this.#memory.contextFor(identity)
      const experiences = await this.#experience.relevant(message)
      const response = await this.#provider.complete({
        system: this.#secrets.sanitizeForModel(buildSystemPrompt(this.#persona, this.#prompts)),
        user: this.#secrets.sanitizeForModel(buildPlayerRequest({ ...context, message, experiences, world: { ...this.#latestWorld, currentTask: message } }))
      })
      if (cancellationEpoch !== this.#cancellationEpoch || !(await this.#taskIsCurrentAttempt(task))) return
      const decision = parseAgentDecision(response.text, { currentPlayerName: identity.name })
      if (decision.validationError) {
        const refusal = `这项指令现在无法执行。原因：${decision.validationError}。请换成当前动作接口支持的目标，或先补齐必要条件。`
        await this.#markFailed(task, decision.validationError)
        await this.#bestEffortReply(identity, refusal)
        return
      }

      const assessment = assessAction(this.#config, decision.action, this.#latestWorld)
      const preparationAction = decision.action.type === 'prepare_for' || decision.action.type === 'equip_best'
      if (assessment.status !== 'ready' && !(preparationAction && assessment.status === 'needs_preparation')) {
        const refusal = refusalFor(assessment)
        await this.#markFailed(task, assessment.reasons.join('；') || '能力评估未通过')
        await this.#bestEffortReply(identity, refusal)
        return
      }

      const policy = this.#policy.authorize(decision.action)
      if (!policy.allowed) {
        const refusal = `我不能执行这项操作。原因：${policy.reason}。这是本地行为准则的硬性限制。`
        await this.#markFailed(task, policy.reason)
        await this.#bestEffortReply(identity, refusal)
        return
      }


      const preparationPurpose = requiredPreparation(message, decision.action)
      if (preparationPurpose) {
        if (this.#proactiveActionRunning) await this.#executor.execute({ type: 'stop' })
        const preparationResult = await this.#executor.execute({ type: 'prepare_for', purpose: preparationPurpose })
        if (cancellationEpoch !== this.#cancellationEpoch || !(await this.#taskIsCurrentAttempt(task))) return
        if (!preparationResult.ok) {
          const safeDetail = this.#secrets.sanitizeForPersistence(preparationResult.detail)
          if (isTransientClientDisconnect(safeDetail)) {
            await this.#requeueForDisconnect(task, 'client_disconnected_during_preparation')
            return
          }
          await this.#markFailed(task, safeDetail || '装备与物资准备未通过')
          await this.#bestEffortExperience({ task: JSON.stringify({ type: 'prepare_for', purpose: preparationPurpose }), context: message, outcome: 'failure', lesson: safeDetail, correction: '下次先核对装备、耐久、食物和任务危险度；条件不足时详细拒绝，不带病冒险。', tags: ['prepare_for', preparationPurpose] })
          const failure = `这项任务暂时不能开始。装备与物资准备没有通过，实际原因：${safeDetail}。补齐条件后我可以重新尝试。`
          await this.#bestEffortReply(identity, failure)
          return
        }
      } else if (this.#proactiveActionRunning) {
        await this.#executor.execute({ type: 'stop' })
      }

      if (cancellationEpoch !== this.#cancellationEpoch || !(await this.#taskIsCurrentAttempt(task))) return
      let actionResult = await this.#executor.execute(decision.action)
      if (cancellationEpoch !== this.#cancellationEpoch || !(await this.#taskIsCurrentAttempt(task))) return
      if (actionResult.ok && decision.action.type === 'gather_resource') {
        const gatheredDetail = actionResult.detail
        actionResult = await this.#executor.execute({ type: 'collect_own_drops', count: decision.action.count, radius: 16 })
        if (cancellationEpoch !== this.#cancellationEpoch || !(await this.#taskIsCurrentAttempt(task))) return
        if (actionResult.ok) actionResult = { ok: true, detail: `${gatheredDetail}; ${actionResult.detail}` }
        else actionResult = { ok: false, detail: `方块已采下，但自有掉落没有全部进入背包：${actionResult.detail}` }
      }
      if (!actionResult.ok) {
        const safeDetail = this.#secrets.sanitizeForPersistence(actionResult.detail)
        if (isTransientClientDisconnect(safeDetail)) {
          await this.#requeueForDisconnect(task, 'client_disconnected_during_action')
          return
        }
        await this.#markFailed(task, safeDetail || '游戏动作返回失败')
        await this.#bestEffortExperience({ task: JSON.stringify(decision.action), context: message, outcome: 'failure', lesson: safeDetail, correction: '下次先检查游戏状态、装备、材料、距离和安全策略，再决定是否接受任务。', tags: [decision.action.type] })
        const failure = `这项任务没有完成。实际原因：${safeDetail}。条件改变后我可以重新排队尝试。`
        await this.#bestEffortReply(identity, failure)
        return
      }

      await this.#tasks.complete(task.id, actionResult.detail)
      if (decision.remember) {
        const fact = this.#secrets.sanitizeForPersistence(decision.remember)
        if (fact && !fact.includes('[REDACTED]')) {
          await this.#memory.rememberFact(identity, fact).catch(error => this.#logger.warn('任务已完成，但长期事实写入失败', error))
        }
      }
      const reply = decision.reply || actionResult.detail
      if (reply) await this.#bestEffortReply(identity, `${this.#config.chat.replyPrefix}${reply}`)
      this.#logger.info('任务已完成', { taskId: task.id, player: identity.name, model: response.model, action: decision.action.type })
    } catch (error) {
      const detail = this.#secrets.sanitizeForPersistence(error instanceof Error ? error.message : String(error))
      this.#logger.error('处理玩家任务失败', { taskId: task.id, player: identity.name, error: detail })
      if (isTransientClientDisconnect(detail)) {
        await this.#requeueForDisconnect(task, 'client_disconnected_during_task')
        return
      }
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || /timeout|timed out|超时/iu.test(error.message))
      const fallback = timedOut ? '我这次思考超时了，这项任务没有执行；请再说一次。' : '这项任务处理失败了，游戏动作没有被当作完成。请稍后重试。'
      await this.#markFailed(task, detail || fallback)
      await this.#bestEffortReply(identity, `${this.#config.chat.replyPrefix}${fallback}`)
    }
  }

  async #handleImmediateStop(identity: PlayerIdentity, request: string): Promise<void> {
    this.#cancellationEpoch++
    const cancelled = await this.#tasks.cancelRunning(`cancelled_by_${identity.name}`)
    const stopTask = await this.#tasks.enqueue({ issuer: identity, request, urgency: 100 })
    await this.#tasks.markRunning(stopTask.id)
    const result = await this.#executor.execute({ type: 'stop' }).catch(error => ({ ok: false, detail: error instanceof Error ? error.message : String(error) }))
    const detail = this.#secrets.sanitizeForPersistence(result.detail)
    if (result.ok) {
      await this.#tasks.complete(stopTask.id, detail || '已停止当前动作')
      await this.#bestEffortReply(identity, cancelled ? '已停止当前动作，正在执行的任务已取消。' : '已停止移动；当前没有正在执行的任务。')
    } else {
      await this.#markFailed(stopTask, detail || '停止动作失败')
      await this.#bestEffortReply(identity, `停止动作没有成功。实际原因：${detail || '客户端未返回原因'}。`)
    }
  }

  async #taskIsCurrentAttempt(expected: TaskRecord): Promise<boolean> {
    return (await this.#tasks.load()).tasks.some(task => task.id === expected.id
      && task.status === 'running'
      && task.attempts === expected.attempts
      && task.startedAt === expected.startedAt)
  }

  async #markFailed(task: TaskRecord, reason: string): Promise<void> {
    await this.#tasks.fail(task.id, reason || '任务失败但未提供原因').catch(error => {
      this.#logger.error('无法把任务写入失败终态，重连时将由恢复机制重新排队', { taskId: task.id, error: this.#secrets.sanitizeForPersistence(error instanceof Error ? error.message : String(error)) })
    })
  }

  async #requeueForDisconnect(task: TaskRecord, reason: string): Promise<void> {
    this.#drainPausedForDisconnect = true
    await this.#tasks.requeue(task.id, reason).catch(error => {
      this.#logger.error('客户端断线任务无法重新排队', { taskId: task.id, error: this.#secrets.sanitizeForPersistence(error instanceof Error ? error.message : String(error)) })
    })
  }

  async #bestEffortReply(identity: PlayerIdentity, message: string): Promise<void> {
    try {
      const sent = await this.#safeChat(message)
      await this.#memory.recordBotReply(identity, sent)
    } catch (error) {
      this.#logger.warn('任务状态已落盘，但游戏内回复发送失败', { player: identity.name, error: this.#secrets.sanitizeForPersistence(error instanceof Error ? error.message : String(error)) })
    }
  }

  async #bestEffortExperience(entry: Parameters<ExperienceStore['add']>[0]): Promise<void> {
    await this.#experience.add(entry).catch(error => this.#logger.warn('任务失败状态已落盘，但经验文件写入失败', error))
  }

  async #safeChat(message: string): Promise<string> {
    const guarded = this.#secrets.safeChat(message)
    const waitMs = Math.max(0, this.#config.chat.cooldownMs - (Date.now() - this.#lastChatAt))
    if (waitMs > 0) await delay(waitMs)
    await this.#executor.chat(guarded.text)
    this.#lastChatAt = Date.now()
    if (!guarded.safe) this.#logger.warn('已阻止敏感聊天内容出站', { reason: guarded.reason })
    return guarded.text
  }
}
