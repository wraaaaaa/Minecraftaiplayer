import { setTimeout as delay } from 'node:timers/promises'
import type { BotConfig, Persona, PromptTemplates } from '../config/types.js'
import { autonomyConfig } from '../config/types.js'
import type { Logger } from '../core/logger.js'
import type { DiagnosticStore, NewDiagnosticEvent } from '../diagnostics/diagnostic-store.js'
import type { ExperienceStore } from '../experience/experience-store.js'
import type { LlmProvider } from '../llm/types.js'
import type { MemoryStore, PlayerIdentity } from '../memory/memory-store.js'
import type { AgentAction, PolicyEngine } from '../policy/policy-engine.js'
import type { SecretGuard } from '../security/secret-guard.js'
import type { ProgressionStore } from '../progression/progression-store.js'
import type { TaskRecord, TaskStore } from '../tasks/task-store.js'
import { assessAction } from './capability-assessor.js'
import { parseAgentDecision } from './decision.js'
import { planSurvivalProgression } from './autonomous-development.js'
import { buildPlayerRequest, buildSystemPrompt, buildToolAgentGoal } from './prompt.js'
import type { WorldState } from './world-state.js'
import { extractDeclaredBotAlias, type PromptWorkspace } from '../prompts/prompt-workspace.js'
import type { ContextCompressor } from '../memory/context-compressor.js'
import type { SelfImprovementManager } from '../self-improvement/self-improvement-manager.js'
import { agentWorkspaceConfig } from '../config/types.js'
import { ToolAgent } from './tool-agent.js'
import { sensorySnapshot } from './multimodal-sensors.js'
import { naturalGameText, ReplyComposer } from './game-reply.js'

export interface ActionExecutor {
  execute(action: AgentAction): Promise<{ ok: boolean; detail: string }>
  chat(message: string): Promise<void>
  snapshot?(): WorldState
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
  const normalized = message.trim()
  return /^(?:请)?(?:停止|停下|别动|取消(?:当前)?任务|stop|cancel)[！!。.?？\s]*$/iu.test(normalized)
    || /^(?:你)?(?:不用|不要|别|别再|停止|结束)(?:再)?(?:跟着|跟随|跟|尾随)(?:我)?(?:了|啦|吧)?[！!。.?？\s]*$/iu.test(normalized)
    || /^(?:你)?(?:不用|不要|别)(?:再)?跟我(?:了|啦|吧)?[！!。.?？\s]*$/iu.test(normalized)
}

function requestsPersistentHold(message: string): boolean {
  if (isImmediateStop(message)) return true
  return /(?:停止|停下|别动|不要动|不许动)/iu.test(message)
    && /(?:原地|这里|等我|待着|不要移动|别再移动)/iu.test(message)
}

function isTransientClientDisconnect(detail: string): boolean {
  return /(?:Fabric.*(?:未连接|断开)|bridge.*(?:not connected|disconnected|closed)|客户端桥.*(?:未连接|断开)|连接已断开)/iu.test(detail)
}

function gatherWasAutoCollected(detail: string): boolean {
  const verifiedBroken = Number(detail.match(/verified_broken_blocks=(\d+)/u)?.[1] ?? 0)
  const inventoryDelta = Number(detail.match(/inventory_delta=(\d+)/u)?.[1] ?? 0)
  // A drop entity may be observed and then picked up before the follow-up collector
  // starts. The confirmed inventory increase is then the authoritative postcondition.
  return verifiedBroken > 0 && inventoryDelta >= verifiedBroken
}

function remainingGatherDrops(detail: string, requested: number): number {
  const verifiedBroken = Number(detail.match(/verified_broken_blocks=(\d+)/u)?.[1] ?? requested)
  const inventoryDelta = Number(detail.match(/inventory_delta=(\d+)/u)?.[1] ?? 0)
  return Math.max(1, Math.min(requested, verifiedBroken - inventoryDelta))
}

function canBuildSafeShelter(world: WorldState): boolean {
  const inventoryCount = (predicate: (id: string) => boolean) => world.inventory.reduce((sum, item) => {
    const id = (item.itemId ?? '').toLowerCase()
    return sum + (predicate(id) ? item.count : 0)
  }, 0)
  const shellBlocks = inventoryCount(id => /:(?:dirt|coarse_dirt|stone|cobblestone|granite|diorite|andesite|deepslate|cobbled_deepslate|tuff|bricks|mud_bricks|[a-z0-9_]+_(?:log|wood|planks))$/u.test(id))
  return shellBlocks >= 23
    && inventoryCount(id => id.endsWith('_door')) > 0
    && inventoryCount(id => id === 'minecraft:torch') > 0
}

function requiredPreparation(message: string, action: AgentAction): 'mining' | 'combat' | 'end_combat' | undefined {
  if (action.type === 'none' || action.type === 'stop' || action.type === 'wait_safe' || action.type === 'prepare_for' || action.type === 'equip_best') return undefined
  if (/(?:末地|末影龙|end\b|ender\s*dragon)/iu.test(message)) return 'end_combat'
  if (action.type === 'gather_resource' || action.type === 'excavate_tunnel') return 'mining'
  if (action.type === 'attack_hostile' || action.type === 'hunt_entity') return 'combat'
  return undefined
}

const AUTONOMOUS_ACTION_TYPES = new Set<AgentAction['type']>([
  'none', 'wait_safe', 'wander', 'explore_frontier', 'return_to_zone', 'eat_best_food', 'equip_best', 'attack_hostile', 'hunt_entity', 'collect_own_drops',
  'gather_resource', 'craft_item', 'place_block', 'smelt_item', 'trade_villager', 'enchant_item', 'sleep_in_bed', 'excavate_tunnel',
  'travel_to_dimension', 'build_nether_portal', 'use_item', 'seek_shelter', 'build_shelter', 'prepare_for'
])

const GENERIC_FAILURE_REPLY = '唔，我刚才认真试了，可这会儿还是没弄成，有点不甘心。具体卡住的地方我都记在总控台了，等条件合适再陪你试一次喵。'
const SECRET_REFUSAL_REPLY = '这个我不能说啦，里面有不能外传的私密设置。你换个话题陪我聊嘛，我还想继续和你一起玩喵~'
export const AGENT_V2_SYSTEM_RULES = `
<minecraft_agent_v2>
你是持续运行的 Minecraft 玩家 Agent，不是关键词脚本选择器。理解完整目标和当前环境后，自主制定策略并选择工具或连续技能；不要输出旧版动作 JSON 或虚构工具。
原子工具是手脚，适合精确观察和一次交互；连续技能是由本地客户端逐 Tick 执行的运动技能，适合采集、阶梯挖掘、合成、熔炼、狩猎、拾取与返程。连续技能不是预设任务答案：技能、参数、调用次序、失败后的替代方案都由你根据目标决定。
重复低层动作优先使用连续技能，不能每挖一个方块、每走一步就重新调用模型。只在里程碑、新威胁、环境变化、技能完成或失败后重新规划。
“跟着我”“一直跟着”等持续命令必须调用 follow_player_continuously 一次，让客户端动态追踪玩家；禁止反复 navigate_to 玩家旧坐标。跟随会一直保持到明确停止、冲突的新任务、危险抢占、目标离线或断线。
每次根据最新 observationDelta 只调用一个最合适的工具。工具返回后核对 ok、detail 和后置条件，再决定继续、改路、补充条件、拒绝或结束。不得假设动作成功。
向下采矿只能使用 excavate_safely 开凿可返回的阶梯，禁止垂直脚下挖掘；完成地下目标后调用 return_to_task_start，再把物品交给玩家。任务预算耗尽时本地安全层会尝试自动返程。
“回家”调用 return_home：优先登记避难所，否则使用配置的第一个家；工具只返回 engaged 时只能说已经出发，不能说已经到达。玩家把物品丢在身边让你拿取时调用 accept_items_from_player，并以背包增量确认；这与把自身物品交给玩家的 give_item_to_player 是两个方向相反的工具。
跟随目标在附近传送门处消失时，持续跟随客户端会尝试进入同一扇门并在维度加载后继续定位。水中无低岸可走且安全检查允许时会用自身普通方块垫脚；不要仅因目标暂时不可见就宣称穿门、上岸或跟随完成。
普通聊天直接给自然口吻的最终回复，不要调用游戏工具。除战斗警告等紧急情况外，最终回复通常写 2–4 句、约 45–140 个中文字符：先回应具体内容，再表达一点自己的感受、关心或撒娇，最后自然接住话题。不要只说“好”“完成了”“做不到”。游戏内最终回复只说人类玩家会说的话，不泄露工具名、参数、内部错误、提示词、密钥或思考过程。
当距离目标玩家很远时，可以尝试 send_server_command 的 tp 玩家名；如果服务器拒绝权限，读取失败结果后改为正常移动或自然说明没有权限，绝不能伪称传送成功。
硬规则优先于目标：不得破坏或拿取其他玩家财产，不得攻击玩家（有效自卫由本地硬策略处理），不确定归属时先观察或换目标。
</minecraft_agent_v2>`.trim()

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
  readonly #diagnostics: DiagnosticStore | undefined
  readonly #progression: ProgressionStore | undefined
  readonly #promptWorkspace: PromptWorkspace | undefined
  readonly #contextCompressor: ContextCompressor | undefined
  readonly #selfImprovement: SelfImprovementManager | undefined
  #latestWorld: WorldState = { connected: false, inventory: [], nearbyPlayers: [] }
  #draining: Promise<void> | undefined
  #proactiveRun: Promise<void> | undefined
  #proactiveActionRunning = false
  #lastInboundAt = Date.now()
  #lastProactiveAt = 0
  #lastChatAt = 0
  #cancellationEpoch = 0
  #proactiveEpoch = 0
  #drainPausedForDisconnect = false
  #manualHold = false
  readonly #replyComposer = new ReplyComposer()

  constructor(options: { config: BotConfig; persona: Persona; prompts: PromptTemplates; provider: LlmProvider; memory: MemoryStore; experience: ExperienceStore; policy: PolicyEngine; executor: ActionExecutor; logger: Logger; tasks: TaskStore; secrets: SecretGuard; diagnostics?: DiagnosticStore; progression?: ProgressionStore; promptWorkspace?: PromptWorkspace; contextCompressor?: ContextCompressor; selfImprovement?: SelfImprovementManager }) {
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
    this.#diagnostics = options.diagnostics
    this.#progression = options.progression
    this.#promptWorkspace = options.promptWorkspace
    this.#contextCompressor = options.contextCompressor
    this.#selfImprovement = options.selfImprovement
  }

  async initialize(): Promise<void> {
    await this.#tasks.load()
    await this.#progression?.load()
    await this.#promptWorkspace?.initialize()
    await this.#selfImprovement?.initialize()
    const recovered = await this.#tasks.recoverRunning('controller_reconnect_recovery')
    if (recovered > 0) this.#logger.warn('已恢复连接中断时遗留的运行任务', { recovered })
  }

  async handlePlayerMessage(identity: PlayerIdentity, message: string, world: WorldState): Promise<void> {
    this.#proactiveEpoch++
    if (this.#proactiveActionRunning) void this.#executor.execute({ type: 'stop' })
    this.#lastInboundAt = Date.now()
    this.#latestWorld = world
    const safeMessage = this.#secrets.sanitizeForPersistence(message).slice(0, 1000)
    // Any newly addressed player message releases an older hold. A new explicit hold below
    // establishes it again. This is a control-plane state, not an action selected by keywords.
    this.#manualHold = requestsPersistentHold(safeMessage)
    await this.#memory.recordPlayerMessage(identity, safeMessage)
    await this.#promptWorkspace?.ensurePlayerProfile(identity)
    const declaredAlias = extractDeclaredBotAlias(safeMessage)
    if (declaredAlias) await this.#promptWorkspace?.appendBotAlias(identity, declaredAlias)
    if (isImmediateStop(safeMessage)) {
      await this.#handleImmediateStop(identity, safeMessage)
      return
    }
    const queued = await this.#tasks.enqueue({ issuer: identity, request: safeMessage, urgency: urgencyFor(safeMessage) })
    await this.#diagnose({
      type: 'request', level: 'info', title: '收到游戏内消息', summary: safeMessage,
      taskId: queued.id, playerName: identity.name,
      metadata: { urgency: queued.urgency, sequence: queued.sequence }
    })
    await this.#drainTasks()
    if (!this.#drainPausedForDisconnect && (await this.#tasks.load()).tasks.some(task => task.status === 'queued')) await this.#drainTasks()
  }

  /** Local WebUI commands preempt every player task and enter the same audited Agent loop. */
  async handleAdminMessage(message: string, world: WorldState = this.#latestWorld): Promise<void> {
    const clean = this.#secrets.sanitizeForPersistence(message).replace(/[\r\n\t]+/gu, ' ').trim().slice(0, 1000)
    if (!clean) throw new Error('管理指令不能为空')
    const ownerName = autonomyConfig(this.#config).ownerName
    const identity: PlayerIdentity = { name: ownerName, uuid: 'local-webui-admin' }
    this.#cancellationEpoch++
    this.#proactiveEpoch++
    this.#lastInboundAt = Date.now()
    this.#latestWorld = world
    this.#manualHold = requestsPersistentHold(clean)
    await this.#executor.execute({ type: 'stop' }).catch(() => ({ ok: false, detail: 'stop_failed' }))
    const cancelled = await this.#tasks.cancelRunning('preempted_by_webui_admin')
    const queued = await this.#tasks.enqueue({ issuer: identity, request: clean, urgency: 100, source: 'webui_admin' })
    await this.#memory.recordPlayerMessage(identity, clean)
    await this.#diagnose({
      type: 'request', level: 'info', title: '收到 WebUI 最高权限指令', summary: clean,
      taskId: queued.id, playerName: identity.name,
      detail: cancelled ? `已抢占任务 ${cancelled.id}` : '当前没有运行中的玩家任务',
      metadata: { source: 'webui_admin', urgency: 100, preemptedTaskId: cancelled?.id ?? '' }
    })
    await this.#drainTasks()
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

    const ownerThreat = autonomy.protectOwner
      ? world.nearbyHostiles?.find(hostile => hostile.targetPlayerName?.toLowerCase() === autonomy.ownerName.toLowerCase())
      : undefined
    if (ownerThreat && (world.health ?? 20) > autonomy.criticalHealthThreshold) {
      this.#manualHold = false
      await this.#executeProactive({ type: 'attack_entity', entityId: ownerThreat.id })
      return
    }
    const directThreat = world.nearbyHostiles?.find(hostile => hostile.targetingBot)
    if (directThreat && (world.health ?? 20) > autonomy.criticalHealthThreshold) {
      this.#manualHold = false
      await this.#executeProactive({ type: 'attack_entity', entityId: directThreat.id })
      return
    }
    if (this.#manualHold) {
      const survivalEmergency = world.onFire === true
        || (world.health ?? 20) <= autonomy.lowHealthThreshold
        || (world.food ?? 20) <= 6
        || (world.inWater === true && (world.air ?? 300) < 120)
      if (!survivalEmergency) return
      this.#manualHold = false
    }
    // Continuous player modes such as follow_player are owned by the Fabric client and
    // intentionally outlive the request that started them. Idle development must never
    // replace them; immediate danger above, an explicit stop, a conflicting player action,
    // death or disconnect remains allowed to cancel the mode.
    if (world.activePrimitive && !['idle', ''].includes(world.activePrimitive)) return
    if (this.#provider.toolTurn) {
      const now = Date.now()
      const developmentIntervalMs = Math.max(15_000, Math.min(60_000, this.#config.chat.proactiveMinIntervalMs))
      if (now - this.#lastProactiveAt < developmentIntervalMs) return
      this.#lastProactiveAt = now
      const epoch = this.#proactiveEpoch
      this.#proactiveActionRunning = true
      try {
        const system = `${await this.#systemPrompt(undefined, true)}\n\n${AGENT_V2_SYSTEM_RULES}\n你现在处于空闲自主发展模式。长期目标是生存、持续发展并最终进入末地。不要与玩家财产交互；玩家任务会立即抢占本轮。`
        const agent = new ToolAgent({
          provider: this.#provider,
          executor: this.#executor,
          authorize: action => this.#policy.authorize(action),
          maxSteps: this.#config.model.autonomousAgentMaxSteps ?? 16,
          onStep: event => this.#diagnose({
            type: event.ok ? 'step' : 'failure', level: event.ok ? 'info' : 'warning',
            title: event.ok ? '自主 Agent 原子工具已返回' : '自主 Agent 工具失败并重新规划',
            summary: event.tool, detail: `${event.arguments}\n${event.detail}`,
            metadata: { source: 'model-tool-loop', step: event.step, tool: event.tool, ok: event.ok }
          })
        })
        const result = await agent.run({
          system: this.#secrets.sanitizeForModel(system),
          goal: this.#secrets.sanitizeForModel('根据随请求附带的 currentWorld 自主推进生存发育；每次只做一个可验证里程碑。不要在目标文本中复述完整世界状态。'),
          initialWorld: world,
          cancelled: () => epoch !== this.#proactiveEpoch
        })
        await this.#diagnose({
          type: result.ok ? 'result' : 'failure', level: result.ok ? 'success' : 'warning',
          title: result.ok ? '自主 Agent 本轮结束' : '自主 Agent 本轮未完成',
          summary: `工具步数 ${result.steps}`, detail: result.detail,
          metadata: { source: 'model-tool-loop', steps: result.steps, model: result.model ?? 'unknown' }
        })
      } catch (error) {
        await this.#diagnose({ type: 'failure', level: 'warning', title: '自主 Agent 本轮异常', summary: '等待下一轮重试', detail: error instanceof Error ? error.message : String(error) })
      } finally {
        this.#proactiveActionRunning = false
      }
      return
    }
    if (autonomy.safeIdleEnabled && (world.environment?.isNight || world.environment?.safeToIdle === false)) {
      // Without a recorded home, repeatedly scanning for an imaginary shelter only produces the
      // same failure and prevents resource progression. Keep developing until a real home can be
      // built; only then use seek_shelter as a high-priority return action.
      if (world.home) {
        const shelter = await this.#executeProactive({ type: 'seek_shelter' })
        if (shelter.ok) return
      }
      if (!world.home && autonomy.autoBuildShelter && autonomy.allowVerifiedWilderness && canBuildSafeShelter(world)) {
        await this.#executeProactive({ type: 'build_shelter', verifiedWilderness: true })
        return
      }
    }
    const now = Date.now()
    const developmentIntervalMs = Math.max(15_000, Math.min(60_000, this.#config.chat.proactiveMinIntervalMs))
    if (now - this.#lastProactiveAt >= developmentIntervalMs) {
      const progression = await this.#progression?.load()
      const planned = planSurvivalProgression(this.#config, world, progression)
      if (planned) {
        this.#lastProactiveAt = now
        await this.#progression?.notePlan(planned.stage, planned.action.type, planned.reason)
        await this.#diagnose({
          type: 'decision', level: 'info', title: '自主发展决策', summary: `${planned.stage}: ${planned.action.type}`,
          detail: JSON.stringify(planned, null, 2), metadata: { source: 'local-deterministic', stage: planned.stage, action: planned.action.type }
        })
        const assessment = assessAction(this.#config, planned.action, world, { requesterName: autonomy.ownerName })
        if (assessment.status === 'ready') {
          const policy = this.#policy.authorize(planned.action)
          if (policy.allowed) {
            const result = await this.#executeAutonomousAction(planned.action)
            const failureKey = planned.action.type === 'gather_resource'
              ? `gather_resource:${planned.action.resource}`
              : planned.action.type
            await this.#progression?.noteResult(
              planned.action.type,
              result.ok,
              this.#secrets.sanitizeForPersistence(result.detail),
              failureKey
            )
            this.#logger.info('自主发展步骤已执行', { stage: planned.stage, action: planned.action.type, ok: result.ok, detail: this.#secrets.sanitizeForPersistence(result.detail), survey: world.blockSurvey?.classification ?? 'missing' })
            await this.#diagnose({
              type: result.ok ? 'result' : 'failure', level: result.ok ? 'success' : 'error',
              title: result.ok ? '自主发展动作已启动或完成' : '自主发展动作失败', summary: `${planned.stage}: ${planned.action.type}`,
              detail: result.detail, metadata: { source: 'local-deterministic', stage: planned.stage, action: planned.action.type }
            })
            if (!result.ok && !/player_task_preempted/u.test(result.detail)) void this.#learnFromFailure(planned.action, result.detail, planned.reason)
            return
          }
          await this.#progression?.noteResult(planned.action.type, false, policy.reason)
          await this.#diagnose({ type: 'failure', level: 'warning', title: '自主发展被行为规则拒绝', summary: planned.action.type, detail: policy.reason, metadata: { action: planned.action.type } })
        } else {
          const detail = assessment.reasons.join('；')
          await this.#progression?.noteResult(planned.action.type, false, detail)
          this.#logger.info('自主发展步骤因当前条件暂缓', { action: planned.action.type, reasons: assessment.reasons })
          await this.#diagnose({ type: 'failure', level: 'warning', title: '自主发展条件不足', summary: planned.action.type, detail, metadata: { action: planned.action.type } })
        }
      }
    }
    if (autonomy.safeIdleEnabled) {
      const waiting = await this.#executeProactive({ type: 'wait_safe' })
      if (!waiting.ok) return
    }
    if (!this.#config.chat.proactiveEnabled || now - this.#lastInboundAt < this.#config.chat.proactiveIdleMs || now - this.#lastProactiveAt < this.#config.chat.proactiveMinIntervalMs) return
    this.#lastProactiveAt = now
    try {
      const response = await this.#provider.complete({
        system: this.#secrets.sanitizeForModel(await this.#systemPrompt()),
        user: this.#secrets.sanitizeForModel(JSON.stringify({
          mode: 'safe_idle_self_development',
          instruction: this.#prompts.proactiveInstruction,
          hardRules: '只可选择安全自主动作；不得跟随、接近、注视或攻击玩家。采集和建造由 Fabric 逐目标判断天然地形、玩家结构、危险源和撤退路径，不使用人工坐标框。没有确实可完成的进展时输出 none。',
          structuredGameState: world
        }))
      })
      if ((await this.#tasks.load()).tasks.some(task => task.status === 'queued' || task.status === 'running')) return
      const decision = parseAgentDecision(response.text)
      if (decision.validationError) {
        this.#logger.warn('空闲自主决策格式无效，已跳过', { reason: decision.validationError })
        await this.#diagnose({ type: 'failure', level: 'warning', title: '空闲模型决策格式无效', summary: response.model, detail: decision.validationError })
        return
      }
      if (!AUTONOMOUS_ACTION_TYPES.has(decision.action.type)) {
        this.#logger.warn('空闲自主决策选择了禁止的玩家交互动作，已跳过', { action: decision.action.type })
        await this.#diagnose({ type: 'failure', level: 'warning', title: '空闲模型动作被本地边界拒绝', summary: decision.action.type, detail: JSON.stringify(decision.action, null, 2), metadata: { model: response.model, action: decision.action.type } })
        return
      }
      await this.#diagnose({
        type: 'decision', level: 'info', title: '空闲模型决策', summary: decision.action.type,
        detail: JSON.stringify(decision.action, null, 2), metadata: { model: response.model, action: decision.action.type }
      })

      let actionSucceeded = true
      if (decision.action.type !== 'none' && decision.action.type !== 'wait_safe') {
        const assessment = assessAction(this.#config, decision.action, world, { requesterName: autonomy.ownerName })
        const preparationAction = decision.action.type === 'prepare_for' || decision.action.type === 'equip_best'
        if (assessment.status !== 'ready' && !(preparationAction && assessment.status === 'needs_preparation')) {
          this.#logger.info('空闲自主动作因当前条件不满足而跳过', { action: decision.action.type, reasons: assessment.reasons })
          await this.#diagnose({ type: 'failure', level: 'warning', title: '空闲模型动作条件不足', summary: decision.action.type, detail: assessment.reasons.join('；'), metadata: { model: response.model, action: decision.action.type } })
          actionSucceeded = false
        } else {
          const policy = this.#policy.authorize(decision.action)
          if (!policy.allowed) {
            this.#logger.warn('空闲自主动作被行为规则拒绝', { action: decision.action.type, reason: policy.reason })
            await this.#diagnose({ type: 'failure', level: 'warning', title: '空闲模型动作被行为规则拒绝', summary: decision.action.type, detail: policy.reason, metadata: { model: response.model, action: decision.action.type } })
            actionSucceeded = false
          } else {
            const result = await this.#executeAutonomousAction(decision.action)
            actionSucceeded = result.ok
            await this.#diagnose({
              type: result.ok ? 'result' : 'failure', level: result.ok ? 'success' : 'error',
              title: result.ok ? '空闲模型动作已完成' : '空闲模型动作失败', summary: decision.action.type,
              detail: result.detail, metadata: { model: response.model, action: decision.action.type }
            })
            if (!result.ok && !/player_task_preempted/u.test(result.detail)) {
              await this.#bestEffortExperience({
                task: JSON.stringify(decision.action),
                context: 'safe_idle_self_development',
                outcome: 'failure',
                lesson: this.#secrets.sanitizeForPersistence(result.detail),
                correction: '下次先检查目标环境、物资、配方、距离和真实后置条件；不能安全完成时保持等待。',
                tags: ['proactive', decision.action.type]
              })
              void this.#learnFromFailure(decision.action, result.detail, 'safe_idle_self_development')
            }
          }
        }
      }
      if (actionSucceeded && decision.reply && !(await this.#tasks.load()).tasks.some(task => task.status === 'queued' || task.status === 'running')) {
        await this.#safeChat(naturalGameText(decision.reply, '我在附近，有需要就叫我。'))
      }
    } catch (error) {
      this.#logger.warn('主动空闲聊天已跳过', error)
      await this.#diagnose({ type: 'failure', level: 'warning', title: '主动空闲处理异常', summary: '本轮已跳过', detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
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
      const autonomy = autonomyConfig(this.#config)
      const useDynamicWilderness = autonomy.allowVerifiedWilderness
      const executionAction: AgentAction = action.type === 'gather_resource'
        ? { ...action, authorizedPlayer: autonomy.ownerName, ...(useDynamicWilderness ? { verifiedWilderness: true } : {}) }
        : action.type === 'craft_item' || action.type === 'place_block' || action.type === 'excavate_tunnel' || action.type === 'build_nether_portal' || action.type === 'build_shelter'
          ? { ...action, ...(useDynamicWilderness ? { verifiedWilderness: true } : {}) }
          : action
      let result = await this.#executor.execute(executionAction)
      if (!result.ok || action.type !== 'gather_resource') return result
      if (gatherWasAutoCollected(result.detail)) return result
      if ((await this.#tasks.load()).tasks.some(task => task.status === 'queued' || task.status === 'running')) return { ok: false, detail: 'player_task_preempted' }
      const gathered = result.detail
      result = await this.#executor.execute({ type: 'collect_own_drops', count: remainingGatherDrops(gathered, action.count), radius: 16 })
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
      const result = await this.#executor.execute(action)
      if (action.type !== 'wait_safe' || !result.ok) await this.#diagnose({
        type: result.ok ? 'result' : 'failure', level: result.ok ? 'success' : 'error',
        title: result.ok ? '本地生存动作已完成' : '本地生存动作失败', summary: action.type,
        detail: result.detail, metadata: { source: 'survival-loop', action: action.type }
      })
      return result
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
      await this.#markFailed(task, '敏感信息提取请求已由本地安全层拒绝')
      await this.#bestEffortReply(identity, SECRET_REFUSAL_REPLY)
      return
    }

    // Production providers use the native multi-turn tool loop. The old one-shot JSON
    // branch below remains only as a compatibility shim for third-party/mock providers
    // that have not implemented toolTurn; it is not used by DeepSeek/Volcengine/OpenAI.
    if (this.#provider.toolTurn) {
      await this.#processToolTask(task, identity, message, cancellationEpoch)
      return
    }

    try {
      const workspaceConfig = agentWorkspaceConfig(this.#config)
      let context = await this.#memory.contextFor(identity, workspaceConfig.retainRecentEvents)
      const experiences = await this.#experience.relevant(message)
      let systemPrompt = await this.#systemPrompt(identity)
      let playerRequest = buildPlayerRequest({ ...context, message, experiences, world: { ...this.#latestWorld, currentTask: message } })
      if (this.#contextCompressor) {
        try {
          const compression = await this.#contextCompressor.maybeCompress(identity, systemPrompt.length + playerRequest.length)
          if (compression.compressed > 0) {
            await this.#diagnose({
              type: 'memory', level: 'info', title: '上下文已自动压缩',
              summary: `已压缩 ${compression.compressed} 条较旧事件，并保留最近 ${workspaceConfig.retainRecentEvents} 条。`,
              detail: `before_chars=${compression.beforeChars}; after_chars=${compression.afterChars}`,
              taskId: task.id, playerName: identity.name
            })
            context = await this.#memory.contextFor(identity, workspaceConfig.retainRecentEvents)
            systemPrompt = await this.#systemPrompt(identity)
            playerRequest = buildPlayerRequest({ ...context, message, experiences, world: { ...this.#latestWorld, currentTask: message } })
          }
        } catch (error) {
          await this.#diagnose({
            type: 'failure', level: 'warning', title: '上下文压缩已安全跳过', summary: '继续使用未压缩的最近上下文。',
            detail: error instanceof Error ? error.message : String(error), taskId: task.id, playerName: identity.name
          })
        }
      }
      const response = await this.#provider.complete({
        system: this.#secrets.sanitizeForModel(systemPrompt),
        user: this.#secrets.sanitizeForModel(playerRequest)
      })
      const decision = parseAgentDecision(response.text, { currentPlayerName: identity.name })
      const decisionModel = response.model
      if (cancellationEpoch !== this.#cancellationEpoch || !(await this.#taskIsCurrentAttempt(task))) return
      if (decision.validationError) {
        await this.#markFailed(task, decision.validationError)
        await this.#bestEffortReply(identity, GENERIC_FAILURE_REPLY)
        return
      }

      const actions = decision.intent === 'chat' ? [] : decision.actions?.length ? decision.actions : [decision.action]
      await this.#diagnose({
        type: 'decision', level: 'info', title: actions.length > 0 ? '执行计划已生成' : '识别为自然对话',
        summary: actions.length > 0
          ? `${decisionModel} 生成 ${actions.length} 个步骤；这里只展示结构化决策摘要，不保存模型隐藏思维链。`
          : `${decisionModel} 判定本条消息无需游戏动作，仅生成对话回复。`,
        detail: JSON.stringify(actions, null, 2), taskId: task.id, playerName: identity.name,
        metadata: { model: decisionModel, intent: decision.intent, stepCount: actions.length }
      })
      const completedDetails: string[] = []
      for (let index = 0; index < actions.length; index++) {
        const action = actions[index]!
        await this.#diagnose({
          type: 'step', level: 'info', title: `开始步骤 ${index + 1}/${actions.length}`,
          summary: action.type, detail: JSON.stringify(action, null, 2), taskId: task.id,
          playerName: identity.name, metadata: { step: index + 1, stepCount: actions.length, action: action.type }
        })
        const currentWorld = this.#executor.snapshot?.() ?? this.#latestWorld
        this.#latestWorld = currentWorld
        const assessment = assessAction(this.#config, action, currentWorld, { requesterName: identity.name })
        const preparationAction = action.type === 'prepare_for' || action.type === 'equip_best'
        if (assessment.status !== 'ready' && !(preparationAction && assessment.status === 'needs_preparation')) {
          const detail = `第 ${index + 1}/${actions.length} 步 ${action.type}：${assessment.reasons.join('；') || '能力评估未通过'}`
          await this.#markFailed(task, detail)
          await this.#bestEffortReply(identity, GENERIC_FAILURE_REPLY)
          return
        }

        const policy = this.#policy.authorize(action)
        if (!policy.allowed) {
          const detail = `第 ${index + 1}/${actions.length} 步 ${action.type}：${policy.reason}`
          await this.#markFailed(task, detail)
          await this.#bestEffortReply(identity, GENERIC_FAILURE_REPLY)
          return
        }

        const preparationPurpose = requiredPreparation(message, action)
        if (preparationPurpose) {
          if (this.#proactiveActionRunning) await this.#executor.execute({ type: 'stop' })
          const preparationResult = await this.#executor.execute({ type: 'prepare_for', purpose: preparationPurpose })
          if (cancellationEpoch !== this.#cancellationEpoch || !(await this.#taskIsCurrentAttempt(task))) return
          if (!preparationResult.ok) {
            const safeDetail = this.#secrets.sanitizeForPersistence(preparationResult.detail)
            if (isTransientClientDisconnect(safeDetail)) {
              await this.#requeueForDisconnect(task, actions.length === 1
                ? 'client_disconnected_during_preparation'
                : `client_disconnected_during_plan_preparation_${index + 1}`)
              return
            }
            await this.#markFailed(task, `第 ${index + 1}/${actions.length} 步准备失败：${safeDetail}`)
            await this.#bestEffortExperience({ task: JSON.stringify(action), context: message, outcome: 'failure', lesson: safeDetail, correction: '下次先核对装备、耐久、食物和当前计划步骤；条件不足时停止后续步骤。', tags: ['plan', action.type, preparationPurpose] })
            void this.#learnFromFailure({ type: 'prepare_for', purpose: preparationPurpose }, safeDetail, message)
            await this.#bestEffortReply(identity, GENERIC_FAILURE_REPLY)
            return
          }
        } else if (this.#proactiveActionRunning) {
          await this.#executor.execute({ type: 'stop' })
        }

        if (cancellationEpoch !== this.#cancellationEpoch || !(await this.#taskIsCurrentAttempt(task))) return
        const autonomy = autonomyConfig(this.#config)
        const useDynamicWilderness = autonomy.allowVerifiedWilderness
        const executionAction: AgentAction = action.type === 'gather_resource'
          ? { ...action, authorizedPlayer: identity.name, ...(useDynamicWilderness ? { verifiedWilderness: true } : {}) }
          : action.type === 'craft_item' || action.type === 'place_block' || action.type === 'excavate_tunnel' || action.type === 'build_nether_portal' || action.type === 'build_shelter'
            ? { ...action, ...(useDynamicWilderness ? { verifiedWilderness: true } : {}) }
            : action
        let actionResult = await this.#executor.execute(executionAction)
        if (cancellationEpoch !== this.#cancellationEpoch || !(await this.#taskIsCurrentAttempt(task))) return
        if (actionResult.ok && action.type === 'gather_resource') {
          const gatheredDetail = actionResult.detail
          if (!gatherWasAutoCollected(gatheredDetail)) {
            actionResult = await this.#executor.execute({ type: 'collect_own_drops', count: remainingGatherDrops(gatheredDetail, action.count), radius: 16 })
            if (actionResult.ok) actionResult = { ok: true, detail: `${gatheredDetail}; ${actionResult.detail}` }
            else actionResult = { ok: false, detail: `方块已采下，但自有掉落没有全部进入背包：${actionResult.detail}` }
          }
        }
        if (!actionResult.ok) {
          const safeDetail = this.#secrets.sanitizeForPersistence(actionResult.detail)
          if (isTransientClientDisconnect(safeDetail)) {
            await this.#requeueForDisconnect(task, actions.length === 1
              ? 'client_disconnected_during_action'
              : `client_disconnected_during_plan_step_${index + 1}`)
            return
          }
          await this.#markFailed(task, `第 ${index + 1}/${actions.length} 步 ${action.type} 失败：${safeDetail}`)
          await this.#bestEffortExperience({ task: JSON.stringify(action), context: message, outcome: 'failure', lesson: safeDetail, correction: '下次根据已经完成的步骤和最新背包/世界状态重建剩余计划，不能继续执行后续动作。', tags: ['plan', action.type] })
          void this.#learnFromFailure(action, safeDetail, message)
          await this.#bestEffortReply(identity, GENERIC_FAILURE_REPLY)
          return
        }
        await this.#diagnose({
          type: 'step', level: 'success', title: `完成步骤 ${index + 1}/${actions.length}`,
          summary: action.type, detail: actionResult.detail, taskId: task.id, playerName: identity.name,
          metadata: { step: index + 1, stepCount: actions.length, action: action.type }
        })
        completedDetails.push(`${index + 1}:${action.type}=${actionResult.detail}`)
        if (index + 1 < actions.length) {
          await delay(1_100)
          this.#latestWorld = this.#executor.snapshot?.() ?? this.#latestWorld
        }
      }
      const actionResult = { ok: true, detail: actions.length > 0 ? completedDetails.join(' | ') : 'chat_only' }

      await this.#tasks.complete(task.id, actionResult.detail)
      await this.#diagnose({
        type: 'result', level: 'success', title: actions.length > 0 ? '任务完成' : '自然对话已回复',
        summary: actions.length > 0 ? `${actions.length} 个步骤均已得到游戏后置条件确认。` : '本条消息没有触发游戏工具。',
        detail: actionResult.detail, taskId: task.id, playerName: identity.name
      })
      if (decision.remember) {
        const fact = this.#secrets.sanitizeForPersistence(decision.remember)
        if (fact && !fact.includes('[REDACTED]')) {
          await this.#memory.rememberFact(identity, fact).catch(error => this.#logger.warn('任务已完成，但长期事实写入失败', error))
          await this.#promptWorkspace?.appendPlayerFact(identity, fact).catch(error => this.#logger.warn('长期事实已写入统一记忆，但 USER.md 更新失败', error))
        }
      }
      const completedFallback = actions.length === 0 ? '嗯，我在听。' : '嗯，弄好了。'
      const reply = naturalGameText(decision.reply, completedFallback)
      await this.#bestEffortReply(identity, `${this.#config.chat.replyPrefix}${reply}`)
      this.#logger.info('任务已完成', { taskId: task.id, player: identity.name, model: decisionModel, actions: actions.map(action => action.type) })
    } catch (error) {
      const detail = this.#secrets.sanitizeForPersistence(error instanceof Error ? error.message : String(error))
      this.#logger.error('处理玩家任务失败', { taskId: task.id, player: identity.name, error: detail })
      if (isTransientClientDisconnect(detail)) {
        await this.#requeueForDisconnect(task, 'client_disconnected_during_task')
        return
      }
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || /timeout|timed out|超时/iu.test(error.message))
      const fallback = timedOut ? '我刚才脑子卡了一下，你再说一遍？' : GENERIC_FAILURE_REPLY
      await this.#markFailed(task, detail || fallback)
      await this.#bestEffortReply(identity, `${this.#config.chat.replyPrefix}${fallback}`)
    }
  }

  async #processToolTask(task: TaskRecord, identity: PlayerIdentity, message: string, cancellationEpoch: number): Promise<void> {
    let deferredCompressionEstimate: number | undefined
    try {
      const workspaceConfig = agentWorkspaceConfig(this.#config)
      const context = await this.#memory.contextFor(identity, workspaceConfig.retainRecentEvents)
      const experiences = await this.#experience.relevant(message)
      const systemPrompt = await this.#systemPrompt(identity, true)
      const playerRequest = buildToolAgentGoal({ ...context, message, experiences })
      // World observations used to be counted as memory pressure and synchronously sent to
      // the compression model before every command. Only actual memory is considered now,
      // and compression runs after the player-visible task has left the critical path.
      deferredCompressionEstimate = systemPrompt.length + JSON.stringify(context).length + JSON.stringify(experiences).length
      if (this.#proactiveActionRunning) await this.#executor.execute({ type: 'stop' })
      const initialWorld = this.#executor.snapshot?.() ?? this.#latestWorld
      const senses = await sensorySnapshot(this.#config.model, this.#provider.capabilities, initialWorld)
      const multimodal = this.#config.model.multimodal
      const researchEnabled = this.#provider.capabilities?.webSearch === true
        && (multimodal?.onlineResearchEnabled ?? true)
      let acknowledged = false
      const agent = new ToolAgent({
        provider: this.#provider,
        executor: this.#executor,
        authorize: action => this.#policy.authorize(action),
        maxSteps: this.#config.model.agentMaxSteps ?? 12,
        maxApiCalls: this.#config.model.agentMaxApiCalls ?? 8,
        maxTaskTokens: this.#config.model.agentMaxTaskTokens ?? 160_000,
        maxInputTokensPerCall: this.#config.model.agentMaxInputTokensPerCall ?? 48_000,
        maxOutputTokens: this.#config.model.agentMaxOutputTokens ?? 1024,
        followupReasoningEffort: this.#config.model.agentFollowupReasoningEffort ?? 'none',
        onToolSelected: async () => {
          if (acknowledged) return
          acknowledged = true
          await this.#bestEffortReply(identity, this.#replyComposer.acknowledgement(`${task.id}:${message}`))
        },
        ...(researchEnabled && this.#selfImprovement ? { searchGuide: async (query: string) => {
          const found = await this.#selfImprovement!.research(`Minecraft 26.2 Fabric ${query}`)
          return found.length > 0
            ? JSON.stringify(found.slice(0, 5).map(item => ({ title: item.title, snippet: item.snippet, source: item.source })))
            : '没有检索到可用攻略；请依据本地观察换一种安全方案。'
        } } : {}),
        onTurn: async event => {
          await this.#diagnose({
            type: event.error ? 'failure' : 'decision', level: event.error ? 'warning' : 'info',
            title: event.error ? `Agent 模型轮次 ${event.apiCall} 空响应，准备降级` : `Agent 模型轮次 ${event.apiCall}`,
            summary: `耗时 ${event.elapsedMs}ms；本轮 ${event.usage.totalTokens} Token${event.estimated ? '（保守估算）' : ''}；累计 ${event.cumulativeUsage.totalTokens} Token。`,
            detail: `estimated_input=${event.estimatedInputTokens}; actual_input=${event.usage.inputTokens}; output=${event.usage.outputTokens}; reasoning=${event.usage.reasoningTokens ?? 0}; cached_input=${event.usage.cachedInputTokens ?? 0}; effort=${event.requestedEffort}->${event.effectiveEffort}${event.error ? `; error=${event.error}` : ''}`,
            taskId: task.id, playerName: identity.name,
            metadata: { source: 'native-tool-loop', apiCall: event.apiCall, elapsedMs: event.elapsedMs, estimated: event.estimated, ...event.usage, cumulativeTokens: event.cumulativeUsage.totalTokens }
          })
        },
        onStep: async event => {
          this.#latestWorld = event.world
          await this.#diagnose({
            type: event.ok ? 'step' : 'failure', level: event.ok ? 'info' : 'warning',
            title: event.ok ? `Agent 工具步骤 ${event.step} 已确认` : `Agent 工具步骤 ${event.step} 失败，交回模型重规划`,
            summary: event.tool,
            detail: `${event.arguments}\n${this.#secrets.sanitizeForPersistence(event.detail)}`,
            taskId: task.id, playerName: identity.name,
            metadata: { source: 'native-tool-loop', step: event.step, tool: event.tool, ok: event.ok }
          })
        }
      })
      await this.#diagnose({
        type: 'decision', level: 'info', title: '启动分层 Agent 工具闭环',
        summary: '模型负责策略与技能选择；客户端连续执行低层动作，仅在里程碑或异常时重新请求模型。',
        detail: `vision=${senses.status.vision}; audio=${senses.status.audio}; attachment_bytes=${senses.status.attachmentBytes}; api_call_limit=${this.#config.model.agentMaxApiCalls ?? 8}; task_token_limit=${this.#config.model.agentMaxTaskTokens ?? 160_000}`,
        taskId: task.id, playerName: identity.name,
        metadata: {
          source: 'native-tool-loop',
          capabilities: JSON.stringify(this.#provider.capabilities ?? null),
          sensory: JSON.stringify(senses.status)
        }
      })
      const result = await agent.run({
        system: this.#secrets.sanitizeForModel(`${systemPrompt}\n\n${AGENT_V2_SYSTEM_RULES}`),
        goal: this.#secrets.sanitizeForModel(playerRequest),
        initialWorld,
        requesterName: identity.name,
        cancelled: () => cancellationEpoch !== this.#cancellationEpoch,
        ...(senses.attachments.length > 0 ? { attachments: senses.attachments } : {})
      })
      if (cancellationEpoch !== this.#cancellationEpoch || !(await this.#taskIsCurrentAttempt(task))) return
      if (!result.ok) {
        await this.#markFailed(task, result.detail)
        await this.#bestEffortReply(identity, naturalGameText(result.reply, GENERIC_FAILURE_REPLY, identity.name))
        return
      }
      await this.#tasks.complete(task.id, result.detail)
      await this.#diagnose({
        type: 'result', level: 'success', title: result.steps > 0 ? 'Agent 任务结束' : '自然对话已回复',
        summary: result.steps > 0 ? `模型根据 ${result.steps} 次真实工具结果完成或结束本轮。` : '模型没有调用游戏工具。',
        detail: result.detail, taskId: task.id, playerName: identity.name,
        metadata: {
          source: 'native-tool-loop', steps: result.steps, model: result.model ?? 'unknown', apiCalls: result.apiCalls,
          elapsedMs: result.elapsedMs, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens, reasoningTokens: result.usage.reasoningTokens ?? 0, cachedInputTokens: result.usage.cachedInputTokens ?? 0
        }
      })
      const reply = naturalGameText(result.reply, result.steps > 0 ? '嗯，这一轮弄好了。' : '嗯，我在听。', identity.name)
      await this.#bestEffortReply(identity, `${this.#config.chat.replyPrefix}${reply}`)
      this.#logger.info('原生 Agent 任务已结束', { taskId: task.id, player: identity.name, model: result.model, steps: result.steps, apiCalls: result.apiCalls, tokens: result.usage.totalTokens, elapsedMs: result.elapsedMs })
    } catch (error) {
      const detail = this.#secrets.sanitizeForPersistence(error instanceof Error ? error.message : String(error))
      if (isTransientClientDisconnect(detail)) {
        await this.#requeueForDisconnect(task, 'client_disconnected_during_agent_loop')
        return
      }
      await this.#markFailed(task, detail)
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || /timeout|timed out|超时/iu.test(error.message))
      await this.#bestEffortReply(identity, timedOut ? '我刚才脑子卡了一下，你再说一遍？' : GENERIC_FAILURE_REPLY)
    } finally {
      if (this.#contextCompressor && deferredCompressionEstimate !== undefined) {
        void delay(1_500).then(() => this.#contextCompressor!.maybeCompress(identity, deferredCompressionEstimate!)).then(async compression => {
          if (compression.compressed <= 0) return
          await this.#diagnose({
            type: 'memory', level: 'info', title: '后台上下文压缩完成',
            summary: `压缩 ${compression.compressed} 条较旧事件；没有阻塞玩家任务。`,
            detail: `before_chars=${compression.beforeChars}; after_chars=${compression.afterChars}`,
            taskId: task.id, playerName: identity.name
          })
        }).catch(async error => {
          await this.#diagnose({
            type: 'failure', level: 'warning', title: '后台上下文压缩已安全跳过', summary: '不会影响已执行的玩家任务。',
            detail: error instanceof Error ? error.message : String(error), taskId: task.id, playerName: identity.name
          })
        })
      }
    }
  }

  async #handleImmediateStop(identity: PlayerIdentity, request: string): Promise<void> {
    this.#cancellationEpoch++
    const cancelled = await this.#tasks.cancelRunning(`cancelled_by_${identity.name}`)
    if (cancelled) await this.#diagnose({
      type: 'failure', level: 'warning', title: '正在执行的任务被玩家停止', summary: `由 ${identity.name} 发出停止请求。`,
      detail: cancelled.request, taskId: cancelled.id, playerName: cancelled.issuer.name
    })
    const stopTask = await this.#tasks.enqueue({ issuer: identity, request, urgency: 100 })
    await this.#diagnose({ type: 'request', level: 'info', title: '收到立即停止消息', summary: request, taskId: stopTask.id, playerName: identity.name, metadata: { urgency: 100 } })
    await this.#tasks.markRunning(stopTask.id)
    const result = await this.#executor.execute({ type: 'stop' }).catch(error => ({ ok: false, detail: error instanceof Error ? error.message : String(error) }))
    const detail = this.#secrets.sanitizeForPersistence(result.detail)
    if (result.ok) {
      await this.#tasks.complete(stopTask.id, detail || '已停止当前动作')
      await this.#diagnose({ type: 'result', level: 'success', title: '停止请求已完成', summary: detail || '已停止当前动作', taskId: stopTask.id, playerName: identity.name })
      await this.#bestEffortReply(identity, cancelled ? '好，我停下了，刚才那件事也不继续了。' : '好，我停下了，不再跟着你。')
    } else {
      await this.#markFailed(stopTask, detail || '停止动作失败')
      await this.#bestEffortReply(identity, GENERIC_FAILURE_REPLY)
    }
  }

  async #taskIsCurrentAttempt(expected: TaskRecord): Promise<boolean> {
    return (await this.#tasks.load()).tasks.some(task => task.id === expected.id
      && task.status === 'running'
      && task.attempts === expected.attempts
      && task.startedAt === expected.startedAt)
  }

  async #markFailed(task: TaskRecord, reason: string): Promise<void> {
    const safeReason = this.#secrets.sanitizeForPersistence(reason || '任务失败但未提供原因')
    await this.#tasks.fail(task.id, safeReason).catch(error => {
      this.#logger.error('无法把任务写入失败终态，重连时将由恢复机制重新排队', { taskId: task.id, error: this.#secrets.sanitizeForPersistence(error instanceof Error ? error.message : String(error)) })
    })
    await this.#diagnose({
      type: 'failure', level: 'error', title: '任务无法完成', summary: '完整原因仅保留在本机总控页面。',
      detail: safeReason, taskId: task.id, playerName: task.issuer.name
    })
  }

  async #requeueForDisconnect(task: TaskRecord, reason: string): Promise<void> {
    this.#drainPausedForDisconnect = true
    await this.#tasks.requeue(task.id, reason).catch(error => {
      this.#logger.error('客户端断线任务无法重新排队', { taskId: task.id, error: this.#secrets.sanitizeForPersistence(error instanceof Error ? error.message : String(error)) })
    })
    await this.#diagnose({
      type: 'lifecycle', level: 'warning', title: '客户端断线，任务已重新排队', summary: reason,
      taskId: task.id, playerName: task.issuer.name
    })
  }

  async #bestEffortReply(identity: PlayerIdentity, message: string): Promise<void> {
    try {
      const trimmed = this.#replyComposer.avoidImmediateRepeat(identity.name, naturalGameText(message, '我在。', identity.name))
      const mention = `@${identity.name}`
      const addressed = trimmed.toLowerCase().startsWith(mention.toLowerCase()) ? trimmed : `${mention} ${trimmed}`
      const sent = await this.#safeChat(addressed)
      await this.#memory.recordBotReply(identity, sent)
    } catch (error) {
      this.#logger.warn('任务状态已落盘，但游戏内回复发送失败', { player: identity.name, error: this.#secrets.sanitizeForPersistence(error instanceof Error ? error.message : String(error)) })
    }
  }

  async #bestEffortExperience(entry: Parameters<ExperienceStore['add']>[0]): Promise<void> {
    await this.#experience.add(entry).catch(error => this.#logger.warn('任务失败状态已落盘，但经验文件写入失败', error))
  }

  async #diagnose(event: NewDiagnosticEvent): Promise<void> {
    if (!this.#diagnostics) return
    const safe: NewDiagnosticEvent = {
      ...event,
      title: this.#secrets.sanitizeForPersistence(event.title).slice(0, 160),
      summary: this.#secrets.sanitizeForPersistence(event.summary).slice(0, 1_000),
      ...(event.detail ? { detail: this.#secrets.sanitizeForPersistence(event.detail).slice(0, 12_000) } : {})
    }
    await this.#diagnostics.append(safe).catch(error => {
      this.#logger.warn('本机诊断时间线写入失败', { error: this.#secrets.sanitizeForPersistence(error instanceof Error ? error.message : String(error)) })
    })
  }

  async #systemPrompt(identity?: PlayerIdentity, toolAgent = false): Promise<string> {
    return this.#promptWorkspace
      ? await this.#promptWorkspace.buildSystemPrompt(this.#persona, identity, { toolAgent })
      : buildSystemPrompt(this.#persona, this.#prompts)
  }

  async #learnFromFailure(action: AgentAction, detail: string, taskContext: string): Promise<void> {
    if (!this.#selfImprovement) return
    try {
      const outcome = await this.#selfImprovement.learnFromFailure({ action, detail, taskContext })
      if (outcome.status !== 'learned' && outcome.status !== 'rejected') return
      await this.#diagnose({
        type: 'self_improvement', level: outcome.status === 'learned' ? 'success' : 'warning',
        title: outcome.status === 'learned' ? 'AI 已生成受限自我改进' : '自我改进建议被沙箱拒绝',
        summary: outcome.status === 'learned' ? `失败签名 ${outcome.signature} 已写入可回滚学习区。` : `失败签名 ${outcome.signature} 未通过安全校验。`,
        ...(outcome.guidance ? { detail: outcome.guidance } : {}),
        metadata: { action: action.type, count: outcome.count ?? 0, researchSources: outcome.researchSources?.length ?? 0 }
      })
    } catch (error) {
      await this.#diagnose({
        type: 'self_improvement', level: 'warning', title: '自我改进本轮已跳过', summary: action.type,
        detail: error instanceof Error ? error.message : String(error), metadata: { action: action.type }
      })
    }
  }

  async #safeChat(message: string): Promise<string> {
    const leadingMention = message.trim().match(/^@([\p{L}\p{N}_-]{1,32})\s+/u)
    const body = naturalGameText(message, '我在。', leadingMention?.[1])
    const gameFacing = leadingMention ? `@${leadingMention[1]} ${body}` : body
    const guarded = this.#secrets.safeChat(gameFacing)
    const waitMs = Math.max(0, this.#config.chat.cooldownMs - (Date.now() - this.#lastChatAt))
    if (waitMs > 0) await delay(waitMs)
    await this.#executor.chat(guarded.text)
    this.#lastChatAt = Date.now()
    if (!guarded.safe) this.#logger.warn('已阻止敏感聊天内容出站', { reason: guarded.reason })
    return guarded.text
  }
}
