import { setTimeout as delay } from 'node:timers/promises'
import type { ReasoningEffort } from '../config/types.js'
import type { LlmInputAttachment, LlmProvider, LlmToolCall, LlmToolDefinition, LlmToolResult, LlmUsage } from '../llm/types.js'
import type { AgentAction, PolicyDecision } from '../policy/policy-engine.js'
import type { WorldState } from './world-state.js'

export interface ToolAgentExecutor {
  execute(action: AgentAction): Promise<{ ok: boolean; detail: string }>
  chat(message: string): Promise<void>
  snapshot?(): WorldState
}

export interface ToolAgentRunResult {
  ok: boolean
  reply: string
  steps: number
  detail: string
  model?: string
  apiCalls: number
  usage: LlmUsage
  elapsedMs: number
}

export interface ToolAgentStepEvent {
  step: number
  tool: string
  arguments: string
  ok: boolean
  detail: string
  world: WorldState
}

export interface ToolAgentTurnEvent {
  apiCall: number
  elapsedMs: number
  estimatedInputTokens: number
  usage: LlmUsage
  cumulativeUsage: LlmUsage
  requestedEffort: ReasoningEffort
  effectiveEffort: ReasoningEffort
}

const objectSchema = (properties: Record<string, unknown>, required = Object.keys(properties)): Record<string, unknown> => ({
  type: 'object', properties, required, additionalProperties: false
})
const number = (description: string): Record<string, unknown> => ({ type: 'number', description })
const integer = (description: string, minimum?: number, maximum?: number): Record<string, unknown> => ({
  type: 'integer', description, ...(minimum === undefined ? {} : { minimum }), ...(maximum === undefined ? {} : { maximum })
})
const string = (description: string): Record<string, unknown> => ({ type: 'string', description })

/**
 * The model sees concrete atomic affordances plus cancellable continuous motor skills.
 * Skills accelerate repetitive ticks; they never start from chat keywords or choose the
 * player's overall goal, order, parameters, or recovery strategy on the model's behalf.
 */
export const AGENT_TOOLS: readonly LlmToolDefinition[] = Object.freeze([
  { name: 'observe_world', description: '立即读取最新游戏状态。动作执行后结果已自动附带新状态；只有需要重新确认时再调用。', parameters: objectSchema({}) },
  { name: 'navigate_to', description: '使用碰撞安全寻路走到一个明确坐标。只负责移动，不会自动挖路、采集或执行后续任务。', parameters: objectSchema({
    x: number('目标 X'), y: number('目标 Y'), z: number('目标 Z'),
    stop_distance: number('在目标多少格内停下，通常 1 到 2'), sprint: { type: 'boolean', description: '是否冲刺' }
  }) },
  { name: 'look_at', description: '把视角转向一个世界坐标。', parameters: objectSchema({ x: number('X'), y: number('Y'), z: number('Z') }) },
  { name: 'select_hotbar', description: '选择快捷栏槽位。槽位为 0 到 8。', parameters: objectSchema({ slot: integer('快捷栏槽位', 0, 8) }) },
  { name: 'break_block', description: '破坏指定坐标的一块方块并等待服务端确认。必须使用观察中出现的精确坐标；Fabric 会硬性拒绝疑似玩家建筑或不安全目标。', parameters: objectSchema({
    x: integer('方块 X'), y: integer('方块 Y'), z: integer('方块 Z'), expected_block_id: string('观察到的完整方块 ID，例如 minecraft:oak_log')
  }) },
  { name: 'place_block', description: '把背包中的一个方块放到指定空气方格并等待服务端确认。Fabric 会验证支撑面、碰撞、附近建筑和归属。', parameters: objectSchema({
    x: integer('目标空气方格 X'), y: integer('目标空气方格 Y'), z: integer('目标空气方格 Z'), item_id: string('要放置的完整物品 ID')
  }) },
  { name: 'attack_entity', description: '对观察中指定 entity_id 的实体执行一次合法近战攻击；不会自动选择或追杀其他目标。', parameters: objectSchema({ entity_id: string('观察中的实体 ID') }) },
  { name: 'interact_entity', description: '用主手与指定实体交互一次，例如村民、动物或载具。', parameters: objectSchema({ entity_id: string('观察中的实体 ID') }) },
  { name: 'interact_block', description: '用指定手与一块精确坐标方块交互一次，例如门、床、工作站、熔炉。未知归属容器会被硬策略拒绝。', parameters: objectSchema({
    x: integer('方块 X'), y: integer('方块 Y'), z: integer('方块 Z'), hand: { type: 'string', enum: ['main', 'off'], description: '使用的手' }
  }) },
  { name: 'use_held_item', description: '使用当前手中物品一次，并等待可观察后置条件。进食、喝药水、拉弓等都从这个接口开始。', parameters: objectSchema({ hand: { type: 'string', enum: ['main', 'off'] } }) },
  { name: 'drop_inventory_item', description: '从自己的背包指定槽位丢出一定数量。不会自动寻找玩家或移动。', parameters: objectSchema({ slot: integer('背包槽位', 0, 35), count: integer('数量', 1, 64) }) },
  { name: 'craft_recipe', description: '执行一个已解锁且材料充足的具体配方一次或多次。只合成指定成品，不会自动采材料或继续后续流程。', parameters: objectSchema({ item_id: string('完整成品物品 ID'), count: integer('目标成品数量', 1, 64) }) },
  { name: 'gather_resource', description: '连续采集一种天然资源并收集本次产生的掉落。模型决定资源和数量；客户端在多格范围内逐目标寻路、避障、验明天然性和危险，不会逐方块请求模型。', parameters: objectSchema({
    resource: string('资源类别或完整方块 ID，例如 logs、coal_ore、iron_ore、diamond_ore'), count: integer('目标数量', 1, 64)
  }) },
  { name: 'craft_item', description: '连续完成一种物品的配方制作，包括客户端可验证的工作台交互。缺材料时会返回真实缺口，由模型决定下一步。', parameters: objectSchema({ item_id: string('完整成品物品 ID'), count: integer('目标成品数量', 1, 64) }) },
  { name: 'smelt_items', description: '使用安全熔炉连续熔炼或烹饪。客户端负责容器交互、燃料与结果确认；缺工作站、燃料或原料时返回真实原因。', parameters: objectSchema({
    input_item_id: string('完整输入物品 ID'), output_item_id: string('完整输出物品 ID'), count: integer('数量', 1, 64)
  }) },
  { name: 'excavate_safely', description: '连续开凿可步行的安全阶梯/隧道，绝不垂直脚下挖掘。模型决定资源、目标高度和长度；客户端逐格避开玩家建筑、岩浆/危险流体并保留返程路线。下降后应继续搜索目标，完成目标后用 return_to_task_start 返回。', parameters: objectSchema({
    resource: string('沿途重点寻找的资源类别，例如 diamond_ore；普通通道可填 stone'), target_y: integer('目标 Y 高度', -2048, 2048), length: integer('本次最多推进的阶梯或隧道长度', 2, 64)
  }) },
  { name: 'return_to_task_start', description: '沿安全阶梯向本任务开始时的高度返回；必要时使用自身普通方块搭设支撑。只在曾经向下开凿后调用。', parameters: objectSchema({}) },
  { name: 'collect_own_drops', description: '连续寻路并拾取本任务由 Bot 自己产生和登记的掉落，不会捡取玩家物品。', parameters: objectSchema({ item_id: string('目标物品 ID 或资源名'), count: integer('数量', 1, 64), radius: integer('搜索半径', 2, 32) }) },
  { name: 'give_item_to_player', description: '把自己背包中的指定物品交给在场玩家。客户端负责接近、朝向和丢出，并验证物品确实离开自身背包。', parameters: objectSchema({ item_id: string('完整物品 ID'), count: integer('数量', 1, 64), player: string('玩家名') }) },
  { name: 'equip_for', description: '根据用途连续选择并穿戴当前背包中最合适的工具、武器和护甲。', parameters: objectSchema({ purpose: { type: 'string', enum: ['general', 'mining', 'combat', 'end_combat'] } }) },
  { name: 'hunt_for', description: '连续寻找、追击合法的未驯服生物或敌对目标并收集掉落。', parameters: objectSchema({ purpose: { type: 'string', enum: ['food', 'wool', 'leather', 'ender_pearl', 'blaze_rod'] }, count: integer('目标掉落数量', 1, 64) }) },
  { name: 'send_server_command', description: '尝试发送一个服务器命令。目前硬策略只允许“tp 玩家名”或“teleport 玩家名”，表示把 Bot 自己传送到该玩家；无权限时会返回失败，随后应改用正常寻路或向玩家说明。', parameters: objectSchema({ command: string('不带开头斜杠的命令') }) },
  { name: 'stop_all_actions', description: '立即释放移动和交互按键并停止当前动作。', parameters: objectSchema({}) },
  { name: 'wait_ticks', description: '原地等待少量游戏刻后重新观察。20 tick 约一秒。', parameters: objectSchema({ ticks: integer('等待 tick 数', 1, 100) }) }
])

const GUIDE_SEARCH_TOOL: LlmToolDefinition = {
  name: 'search_game_guide',
  description: '联网搜索 Minecraft/Fabric/服务器机制攻略。仅在本地观察与已有经验不足以解决新问题时调用；结果会缓存并限长，不能用搜索结果绕过安全规则。',
  parameters: objectSchema({ query: string('不含服务器地址、密钥或本地路径的简短检索词') })
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参数必须是 JSON 对象')
  return value as Record<string, unknown>
}
function finite(args: Record<string, unknown>, key: string): number {
  const value = args[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`参数 ${key} 必须是有限数字`)
  return value
}
function whole(args: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = finite(args, key)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`参数 ${key} 必须是 ${min}..${max} 的整数`)
  return value
}
function text(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`参数 ${key} 必须是非空字符串`)
  return value.trim()
}

type ToolOperation = AgentAction | 'observe' | { waitTicks: number } | { returnToStart: true } | { searchQuery: string }

function toAction(call: LlmToolCall, requesterName?: string): ToolOperation {
  let parsed: unknown
  try { parsed = JSON.parse(call.arguments || '{}') } catch { throw new Error('工具参数不是有效 JSON') }
  const args = record(parsed)
  switch (call.name) {
    case 'observe_world': return 'observe'
    case 'navigate_to': return {
      type: 'navigate_to', x: finite(args, 'x'), y: finite(args, 'y'), z: finite(args, 'z'),
      stopDistance: Math.max(0.5, Math.min(4, finite(args, 'stop_distance'))), sprint: args.sprint === true
    }
    case 'look_at': return { type: 'look_at', x: finite(args, 'x'), y: finite(args, 'y'), z: finite(args, 'z') }
    case 'select_hotbar': return { type: 'select_hotbar', slot: whole(args, 'slot', 0, 8) }
    case 'break_block': return {
      type: 'break_block_at', x: whole(args, 'x', -30_000_000, 30_000_000), y: whole(args, 'y', -2048, 2048), z: whole(args, 'z', -30_000_000, 30_000_000),
      expectedBlockId: text(args, 'expected_block_id'), ...(requesterName ? { authorizedPlayer: requesterName } : {})
    }
    case 'place_block': return {
      type: 'place_block_at', x: whole(args, 'x', -30_000_000, 30_000_000), y: whole(args, 'y', -2048, 2048), z: whole(args, 'z', -30_000_000, 30_000_000), itemId: text(args, 'item_id')
    }
    case 'attack_entity': return { type: 'attack_entity', entityId: text(args, 'entity_id') }
    case 'interact_entity': return { type: 'interact_entity', entityId: text(args, 'entity_id') }
    case 'interact_block': return {
      type: 'interact_block', x: whole(args, 'x', -30_000_000, 30_000_000), y: whole(args, 'y', -2048, 2048), z: whole(args, 'z', -30_000_000, 30_000_000),
      hand: args.hand === 'off' ? 'off' : 'main'
    }
    case 'use_held_item': return { type: 'use_held_item', hand: args.hand === 'off' ? 'off' : 'main' }
    case 'drop_inventory_item': return { type: 'drop_inventory_item', slot: whole(args, 'slot', 0, 35), count: whole(args, 'count', 1, 64) }
    case 'craft_recipe': return { type: 'craft_recipe', itemId: text(args, 'item_id'), count: whole(args, 'count', 1, 64) }
    case 'gather_resource': return {
      type: 'gather_resource', resource: text(args, 'resource'), count: whole(args, 'count', 1, 64),
      verifiedWilderness: true, ...(requesterName ? { authorizedPlayer: requesterName } : {})
    }
    case 'craft_item': return { type: 'craft_item', itemId: text(args, 'item_id'), count: whole(args, 'count', 1, 64), verifiedWilderness: true }
    case 'smelt_items': return { type: 'smelt_item', inputItemId: text(args, 'input_item_id'), outputItemId: text(args, 'output_item_id'), count: whole(args, 'count', 1, 64) }
    case 'excavate_safely': return {
      type: 'excavate_tunnel', resource: text(args, 'resource'), targetY: whole(args, 'target_y', -2048, 2048),
      length: whole(args, 'length', 2, 64), verifiedWilderness: true
    }
    case 'return_to_task_start': return { returnToStart: true }
    case 'collect_own_drops': return { type: 'collect_own_drops', itemId: text(args, 'item_id'), count: whole(args, 'count', 1, 64), radius: whole(args, 'radius', 2, 32) }
    case 'give_item_to_player': return { type: 'drop_item', itemId: text(args, 'item_id'), count: whole(args, 'count', 1, 64), target: text(args, 'player') }
    case 'equip_for': {
      const purpose = text(args, 'purpose')
      if (!['general', 'mining', 'combat', 'end_combat'].includes(purpose)) throw new Error('purpose 无效')
      return { type: 'equip_best', purpose: purpose as 'general' | 'mining' | 'combat' | 'end_combat' }
    }
    case 'hunt_for': {
      const purpose = text(args, 'purpose')
      if (!['food', 'wool', 'leather', 'ender_pearl', 'blaze_rod'].includes(purpose)) throw new Error('purpose 无效')
      return { type: 'hunt_entity', purpose: purpose as 'food' | 'wool' | 'leather' | 'ender_pearl' | 'blaze_rod', count: whole(args, 'count', 1, 64) }
    }
    case 'search_game_guide': return { searchQuery: text(args, 'query').slice(0, 240) }
    case 'send_server_command': return { type: 'send_server_command', command: text(args, 'command').replace(/^\/+/, '') }
    case 'stop_all_actions': return { type: 'stop' }
    case 'wait_ticks': return { waitTicks: whole(args, 'ticks', 1, 100) }
    default: throw new Error(`不存在工具 ${call.name}`)
  }
}

function compactWorldValue(world: WorldState, blockLimit = 32): Record<string, unknown> {
  const survey = world.blockSurvey
  return {
    sequence: world.sequence,
    observedAt: world.observedAt,
    connected: world.connected,
    position: world.position,
    health: world.health,
    maxHealth: world.maxHealth,
    food: world.food,
    saturation: world.saturation,
    experienceLevel: world.experienceLevel,
    air: world.air,
    onFire: world.onFire,
    inWater: world.inWater,
    onGround: world.onGround,
    dimension: world.dimension,
    timeOfDay: world.timeOfDay,
    selectedHotbarSlot: world.selectedHotbarSlot,
    inventory: world.inventory.slice(0, 40),
    equipment: world.equipment,
    nearbyPlayers: world.nearbyPlayers.slice(0, 12),
    nearbyHostiles: world.nearbyHostiles?.slice(0, 12),
    nearbyCreatures: world.nearbyCreatures?.slice(0, 12),
    nearbyItems: world.nearbyItems?.slice(0, 12),
    nearbyBlocks: world.nearbyBlocks?.slice(0, blockLimit),
    blockSurvey: survey ? {
      radius: survey.radius, verticalRadius: survey.verticalRadius, center: survey.center,
      classification: survey.classification, protectedLikely: survey.protectedLikely, reasons: survey.reasons.slice(0, 8),
      resources: survey.resources.slice(0, 16), artificial: survey.artificial.slice(0, 8),
      owned: survey.owned?.slice(0, 8), other: survey.other.slice(0, 8)
    } : undefined,
    environment: world.environment,
    activePrimitive: world.activePrimitive,
    navigationStatus: world.navigationStatus,
    ownerWaypoint: world.ownerWaypoint,
    home: world.home
  }
}

function stringifyCompact(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === 'number' && !Number.isInteger(item) ? Number(item.toFixed(3)) : item)
}

function compactWorld(world: WorldState, blockLimit = 32): string { return stringifyCompact(compactWorldValue(world, blockLimit)) }

function compactObservation(previous: WorldState, current: WorldState): string {
  const beforeInventory = new Map(previous.inventory.map(item => [`${item.slot ?? -1}:${item.itemId ?? item.name}`, item.count]))
  const inventoryChanges = current.inventory.flatMap(item => {
    const key = `${item.slot ?? -1}:${item.itemId ?? item.name}`
    const before = beforeInventory.get(key) ?? 0
    return before === item.count ? [] : [{ itemId: item.itemId ?? item.name, slot: item.slot, before, after: item.count }]
  })
  return stringifyCompact({
    sequence: current.sequence,
    position: current.position,
    vitals: { health: current.health, food: current.food, air: current.air, onFire: current.onFire, inWater: current.inWater },
    inventoryChanges,
    observation: compactWorldValue(current, 12)
  })
}

export function estimateTokens(value: unknown): number {
  const source = typeof value === 'string' ? value : JSON.stringify(value)
  let ascii = 0
  let nonAscii = 0
  for (const character of source) character.codePointAt(0)! <= 0x7f ? ascii++ : nonAscii++
  return Math.max(1, Math.ceil(ascii / 4 + nonAscii * 1.1))
}

const zeroUsage = (): LlmUsage => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
function addUsage(left: LlmUsage, right: LlmUsage): LlmUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    ...((left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0) > 0 ? { reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0) } : {}),
    ...((left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0) > 0 ? { cachedInputTokens: (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0) } : {})
  }
}

function compactOldToolResults(continuation: unknown): unknown {
  if (!Array.isArray(continuation) || continuation.length <= 10) return continuation
  const boundary = continuation.length - 6
  return continuation.map((message, index) => {
    if (index >= boundary || !message || typeof message !== 'object') return message
    const entry = message as Record<string, unknown>
    if (entry.role !== 'tool' || typeof entry.content !== 'string') return message
    try {
      const parsed = JSON.parse(entry.content) as { ok?: boolean; detail?: string; world?: WorldState }
      if (!parsed.world) return message
      const world = parsed.world
      return {
        ...entry,
        content: JSON.stringify({
          ok: parsed.ok,
          detail: parsed.detail,
          compressedObservation: {
            sequence: world.sequence, position: world.position, health: world.health, food: world.food,
            dimension: world.dimension, selectedHotbarSlot: world.selectedHotbarSlot,
            inventory: world.inventory.map(item => ({ itemId: item.itemId, count: item.count, slot: item.slot }))
          }
        })
      }
    } catch { return message }
  })
}

export class ToolAgent {
  readonly #provider: LlmProvider
  readonly #executor: ToolAgentExecutor
  readonly #authorize: (action: AgentAction) => PolicyDecision
  readonly #maxSteps: number
  readonly #maxApiCalls: number
  readonly #maxTaskTokens: number
  readonly #maxInputTokensPerCall: number
  readonly #maxOutputTokens: number
  readonly #followupReasoningEffort: ReasoningEffort
  readonly #onStep: ((event: ToolAgentStepEvent) => Promise<void> | void) | undefined
  readonly #onTurn: ((event: ToolAgentTurnEvent) => Promise<void> | void) | undefined
  readonly #estimate: (value: unknown) => number
  readonly #searchGuide: ((query: string) => Promise<string>) | undefined

  constructor(options: {
    provider: LlmProvider
    executor: ToolAgentExecutor
    authorize: (action: AgentAction) => PolicyDecision
    maxSteps?: number
    maxApiCalls?: number
    maxTaskTokens?: number
    maxInputTokensPerCall?: number
    maxOutputTokens?: number
    followupReasoningEffort?: ReasoningEffort
    onStep?: (event: ToolAgentStepEvent) => Promise<void> | void
    onTurn?: (event: ToolAgentTurnEvent) => Promise<void> | void
    estimateTokens?: (value: unknown) => number
    searchGuide?: (query: string) => Promise<string>
  }) {
    this.#provider = options.provider
    this.#executor = options.executor
    this.#authorize = options.authorize
    this.#maxSteps = Math.max(1, Math.min(128, options.maxSteps ?? 32))
    this.#maxApiCalls = Math.max(1, Math.min(32, options.maxApiCalls ?? 8))
    this.#maxTaskTokens = Math.max(1, Math.floor(options.maxTaskTokens ?? 160_000))
    this.#maxInputTokensPerCall = Math.max(1, Math.floor(options.maxInputTokensPerCall ?? 48_000))
    this.#maxOutputTokens = Math.max(128, Math.min(16_384, options.maxOutputTokens ?? 1024))
    this.#followupReasoningEffort = options.followupReasoningEffort ?? 'none'
    this.#onStep = options.onStep
    this.#onTurn = options.onTurn
    this.#estimate = options.estimateTokens ?? estimateTokens
    this.#searchGuide = options.searchGuide
  }

  async run(input: {
    system: string
    goal: string
    initialWorld: WorldState
    requesterName?: string
    cancelled?: () => boolean
    attachments?: LlmInputAttachment[]
  }): Promise<ToolAgentRunResult> {
    if (!this.#provider.toolTurn) throw new Error('当前模型适配器不支持原生工具调用，不能启动 Agent 闭环')
    const startedAt = Date.now()
    let continuation: unknown
    let toolResults: LlmToolResult[] | undefined
    let world = input.initialWorld
    let previousWorld = input.initialWorld
    let model: string | undefined
    let executedSteps = 0
    let apiCalls = 0
    let cumulativeUsage = zeroUsage()
    const taskStartY = input.initialWorld.position?.y
    let descended = false
    const guideCache = new Map<string, string>()
    const tools = this.#searchGuide ? [...AGENT_TOOLS, GUIDE_SEARCH_TOOL] : [...AGENT_TOOLS]
    const user = [
      `目标：${input.goal}`,
      input.requesterName ? `发起玩家：${input.requesterName}` : '来源：空闲自主目标',
      '下面是起始观察。先决定策略；重复采集、挖掘、合成、熔炼、狩猎和返程应调用连续技能，让本地客户端完成低层动作。只有出现新情况、里程碑或失败才重新规划。每轮最多调用一个工具。',
      compactWorld(world)
    ].join('\n')
    const result = (ok: boolean, reply: string, detail: string): ToolAgentRunResult => ({
      ok, reply, steps: executedSteps, detail, apiCalls, usage: cumulativeUsage, elapsedMs: Date.now() - startedAt,
      ...(model ? { model } : {})
    })

    const returnToStart = async (): Promise<{ ok: boolean; detail: string }> => {
      if (taskStartY === undefined) return { ok: false, detail: 'task_start_height_unknown' }
      const details: string[] = []
      for (let attempt = 0; attempt < 4; attempt++) {
        const current = this.#executor.snapshot?.() ?? world
        const currentY = current.position?.y
        if (currentY === undefined) return { ok: false, detail: `${details.join('; ')}; current_height_unknown` }
        if (currentY >= taskStartY - 1) return { ok: true, detail: details.length > 0 ? details.join('; ') : 'already_at_task_start_height' }
        const action: AgentAction = {
          type: 'excavate_tunnel', resource: 'stone', targetY: Math.round(taskStartY),
          length: Math.max(2, Math.min(64, Math.ceil(taskStartY - currentY))), verifiedWilderness: true
        }
        const policy = this.#authorize(action)
        if (!policy.allowed) return { ok: false, detail: `${details.join('; ')}; policy_denied: ${policy.reason}` }
        const outcome = await this.#executor.execute(action)
        details.push(outcome.detail)
        world = this.#executor.snapshot?.() ?? current
        if (!outcome.ok) return { ok: false, detail: details.join('; ') }
      }
      return { ok: (world.position?.y ?? -Infinity) >= taskStartY - 1, detail: details.join('; ') }
    }

    const stopForBudget = async (detail: string): Promise<ToolAgentRunResult> => {
      let recovery = ''
      if (descended && taskStartY !== undefined && (this.#executor.snapshot?.().position?.y ?? taskStartY) < taskStartY - 2) {
        const returned = await returnToStart()
        recovery = `; automatic_return=${returned.ok}; ${returned.detail}`
      }
      return result(false, '我先停一下，避免在这件事上继续空耗。', `${detail}${recovery}`)
    }

    for (let turn = 0; turn <= this.#maxSteps; turn++) {
      if (input.cancelled?.()) return result(false, '', 'cancelled')
      if (apiCalls >= this.#maxApiCalls) return stopForBudget(`agent_api_call_budget_exhausted:${this.#maxApiCalls}`)
      const request = {
        system: input.system,
        user,
        tools,
        ...(continuation === undefined ? {} : { continuation: compactOldToolResults(continuation) }),
        ...(toolResults === undefined ? {} : { toolResults }),
        ...(apiCalls === 0 && input.attachments?.length ? { attachments: input.attachments } : {}),
        maxOutputTokens: this.#maxOutputTokens,
        ...(apiCalls === 0 ? {} : { reasoningEffort: this.#followupReasoningEffort })
      }
      const estimatedInputTokens = this.#estimate(request)
      if (estimatedInputTokens > this.#maxInputTokensPerCall) {
        return stopForBudget(`agent_input_budget_exhausted:estimated=${estimatedInputTokens};limit=${this.#maxInputTokensPerCall}`)
      }
      const reservedNextTurn = estimatedInputTokens + this.#maxOutputTokens
      if (cumulativeUsage.totalTokens + reservedNextTurn > this.#maxTaskTokens) {
        return stopForBudget(`agent_token_budget_exhausted:used=${cumulativeUsage.totalTokens};next_input_estimate=${estimatedInputTokens};reserved_output=${this.#maxOutputTokens};limit=${this.#maxTaskTokens}`)
      }
      const callStarted = Date.now()
      const response = await this.#provider.toolTurn(request)
      apiCalls++
      model = response.model
      const fallbackOutput = this.#estimate({ text: response.text, toolCalls: response.toolCalls })
      const turnUsage = response.usage ?? {
        inputTokens: estimatedInputTokens,
        outputTokens: fallbackOutput,
        totalTokens: estimatedInputTokens + fallbackOutput
      }
      cumulativeUsage = addUsage(cumulativeUsage, turnUsage)
      await this.#onTurn?.({
        apiCall: apiCalls, elapsedMs: Date.now() - callStarted, estimatedInputTokens, usage: turnUsage,
        cumulativeUsage, requestedEffort: response.requestedEffort, effectiveEffort: response.effectiveEffort
      })
      continuation = response.continuation
      toolResults = undefined
      if (response.toolCalls.length === 0) {
        return result(true, response.text.trim(), executedSteps === 0 ? 'chat_only' : `agent_completed_after_${executedSteps}_tools`)
      }
      if (turn === this.#maxSteps) break

      const results: LlmToolResult[] = []
      for (const [index, call] of response.toolCalls.entries()) {
        if (index > 0) {
          results.push({ callId: call.id, output: JSON.stringify({ ok: false, error: 'skipped: replan after the first concrete tool result' }) })
          continue
        }
        let ok = false
        let detail = ''
        try {
          const operation = toAction(call, input.requesterName)
          if (operation === 'observe') {
            ok = true
            detail = 'fresh_world_snapshot'
          } else if ('waitTicks' in operation) {
            await delay(operation.waitTicks * 50)
            ok = true
            detail = `waited_ticks=${operation.waitTicks}`
          } else if ('returnToStart' in operation) {
            const outcome = await returnToStart()
            ok = outcome.ok
            detail = outcome.detail
          } else if ('searchQuery' in operation) {
            const cached = guideCache.get(operation.searchQuery)
            detail = cached ?? await this.#searchGuide?.(operation.searchQuery) ?? 'online_research_unavailable'
            guideCache.set(operation.searchQuery, detail.slice(0, 4_000))
            detail = detail.slice(0, 4_000)
            ok = detail !== 'online_research_unavailable'
          } else {
            const policy = this.#authorize(operation)
            if (!policy.allowed) detail = `policy_denied: ${policy.reason}`
            else {
              if (operation.type === 'excavate_tunnel' && taskStartY !== undefined && operation.targetY < taskStartY - 2) descended = true
              const outcome = await this.#executor.execute(operation)
              ok = outcome.ok
              detail = outcome.detail
            }
          }
        } catch (error) {
          detail = error instanceof Error ? error.message : String(error)
        }
        if (call.name !== 'observe_world') executedSteps++
        world = this.#executor.snapshot?.() ?? world
        const observation = JSON.parse(compactObservation(previousWorld, world)) as unknown
        previousWorld = world
        results.push({ callId: call.id, output: JSON.stringify({ ok, detail, observationDelta: observation }) })
        await this.#onStep?.({ step: executedSteps, tool: call.name, arguments: call.arguments, ok, detail, world })
      }
      toolResults = results
    }
    return stopForBudget(`agent_step_budget_exhausted:${this.#maxSteps}`)
  }
}
