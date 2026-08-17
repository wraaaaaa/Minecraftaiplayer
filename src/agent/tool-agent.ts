import { setTimeout as delay } from 'node:timers/promises'
import type { ReasoningEffort } from '../config/types.js'
import type { LlmInputAttachment, LlmProvider, LlmToolCall, LlmToolDefinition, LlmToolResult, LlmToolTurnResponse, LlmUsage } from '../llm/types.js'
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
  estimated: boolean
  error?: string
}

export interface ToolAgentSelectionEvent {
  tool: string
  arguments: string
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
 * 模型看到的是具体的原子能力，外加可取消的连续运动技能。
 * 技能用于加速重复的 tick；它们从不因聊天关键词而启动，也不替模型
 * 决定玩家的总体目标、顺序、参数或恢复策略。
 */
export const AGENT_TOOLS: readonly LlmToolDefinition[] = Object.freeze([
  { name: 'observe_world', description: '刷新状态；工具回执已有新状态时勿重复调用。', parameters: objectSchema({}) },
  { name: 'follow_player_continuously', description: '启动客户端持续跟随；只调用一次，明确停止前保持。', parameters: objectSchema({ player: string('玩家名') }) },
  { name: 'return_home', description: '返回已登记住所；没有登记住所时返回配置中的第一个家。', parameters: objectSchema({}) },
  { name: 'navigate_to', description: '碰撞安全地走到坐标。', parameters: objectSchema({
    x: number('X'), y: number('Y'), z: number('Z'), stop_distance: number('停止距离'), sprint: { type: 'boolean' }
  }) },
  { name: 'look_at', description: '看向坐标。', parameters: objectSchema({ x: number('X'), y: number('Y'), z: number('Z') }) },
  { name: 'select_hotbar', description: '选择 0–8 快捷栏。', parameters: objectSchema({ slot: integer('槽位', 0, 8) }) },
  { name: 'break_block', description: '破坏观察中的精确天然方块；客户端硬性保护玩家建筑。', parameters: objectSchema({
    x: integer('X'), y: integer('Y'), z: integer('Z'), expected_block_id: string('完整方块 ID')
  }) },
  { name: 'place_block', description: '在精确空气格放置背包方块并验证。', parameters: objectSchema({
    x: integer('X'), y: integer('Y'), z: integer('Z'), item_id: string('完整物品 ID')
  }) },
  { name: 'attack_entity', description: '近战攻击观察中的非玩家实体一次。', parameters: objectSchema({ entity_id: string('实体 ID') }) },
  { name: 'interact_entity', description: '与观察中的非玩家实体交互一次。', parameters: objectSchema({ entity_id: string('实体 ID') }) },
  { name: 'interact_block', description: '与精确方块交互；未知归属容器会拒绝。', parameters: objectSchema({
    x: integer('X'), y: integer('Y'), z: integer('Z'), hand: { type: 'string', enum: ['main', 'off'] }
  }) },
  { name: 'step_on_block', description: '走到压力板/绊线方块上并站立以触发它（踩踏板开门等）。', parameters: objectSchema({
    x: integer('X'), y: integer('Y'), z: integer('Z')
  }) },
  { name: 'unequip_armor', description: '把身上穿着的盔甲脱下放进背包（方便接收玩家给的新装备）。', parameters: objectSchema({}) },
  { name: 'make_inventory_room', description: '背包装满时腾出空间：丢弃已用尽的工具、腐坏食物和多余的填充方块（绝不丢附魔、贵重物品或正常食物）。', parameters: objectSchema({ free_slots: integer('要腾出的空格数', 1, 4) }) },
  { name: 'use_held_item', description: '使用手中物品一次。', parameters: objectSchema({ hand: { type: 'string', enum: ['main', 'off'] } }) },
  { name: 'eat_safe_food', description: '饥饿值不满时连续选择并吃下安全食物，以服务端饱食度或生命值变化确认。', parameters: objectSchema({}) },
  { name: 'drop_inventory_item', description: '从自己的背包槽丢出物品。', parameters: objectSchema({ slot: integer('槽位', 0, 35), count: integer('数量', 1, 64) }) },
  { name: 'discard_worn_tools', description: '清理耐久即将耗尽且没有附魔的工具/武器；不会丢盔甲、附魔装备或正常耐久物品。', parameters: objectSchema({ remaining_durability: integer('剩余耐久阈值', 0, 16) }) },
  { name: 'craft_recipe', description: '用现有材料执行一个具体配方。', parameters: objectSchema({ item_id: string('成品 ID'), count: integer('数量', 1, 64) }) },
  { name: 'gather_resource', description: '连续寻找、采集天然资源并收取自有掉落。', parameters: objectSchema({ resource: string('类别或方块 ID'), count: integer('数量', 1, 64) }) },
  { name: 'craft_item', description: '连续制作一种物品；缺口会真实返回。', parameters: objectSchema({ item_id: string('成品 ID'), count: integer('数量', 1, 64) }) },
  { name: 'smelt_items', description: '用安全熔炉连续熔炼/烹饪并验证结果。', parameters: objectSchema({
    input_item_id: string('输入 ID'), output_item_id: string('输出 ID'), count: integer('数量', 1, 64)
  }) },
  { name: 'build_shelter', description: '一次启动客户端持续建造完整 3x3 安全小屋（墙、屋顶、门和照明）；建房时必须用它，禁止让模型逐格调用 place_block。需要在指定坐标建造时，先 navigate_to 到现场，再调用一次。', parameters: objectSchema({}) },
  { name: 'excavate_safely', description: '连续挖可返程阶梯/隧道；不垂直下挖并避开财产和流体。', parameters: objectSchema({
    resource: string('目标资源'), target_y: integer('目标 Y', -2048, 2048), length: integer('长度', 2, 64)
  }) },
  { name: 'return_to_task_start', description: '从地下沿安全路线返回任务起始高度。', parameters: objectSchema({}) },
  { name: 'collect_own_drops', description: '连续拾取本任务登记的自有掉落。', parameters: objectSchema({ item_id: string('物品 ID'), count: integer('数量', 1, 64), radius: integer('半径', 2, 32) }) },
  { name: 'give_item_to_player', description: '接近玩家并交付自身物品。', parameters: objectSchema({ item_id: string('物品 ID'), count: integer('数量', 1, 64), player: string('玩家名') }) },
  { name: 'accept_items_from_player', description: '接近明确玩家并拾取其身边刚丢出的物品；以背包真实增量确认。', parameters: objectSchema({ player: string('玩家名'), item_id: string('物品 ID，可填 any'), count: integer('数量', 1, 64), radius: integer('玩家周围搜索半径', 1, 6) }) },
  { name: 'equip_for', description: '穿装备/穿戴：按用途从背包穿上当前最好的盔甲和主手工具；general 即普通穿戴。', parameters: objectSchema({ purpose: { type: 'string', enum: ['general', 'mining', 'combat', 'end_combat'] } }) },
  { name: 'hunt_for', description: '连续狩猎合法目标并收取掉落。', parameters: objectSchema({ purpose: { type: 'string', enum: ['food', 'wool', 'leather', 'ender_pearl', 'blaze_rod'] }, count: integer('数量', 1, 64) }) },
  { name: 'send_server_command', description: '仅尝试 tp/teleport 到玩家；无权限后改用寻路。', parameters: objectSchema({ command: string('不带 / 的命令') }) },
  { name: 'stop_all_actions', description: '立即停止动作并释放按键。', parameters: objectSchema({}) },
  { name: 'wait_ticks', description: '等待 1–100 tick；20 tick≈1秒。', parameters: objectSchema({ ticks: integer('tick', 1, 100) }) }
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
function optionalText(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

type ToolOperation = AgentAction | 'observe' | { waitTicks: number } | { returnToStart: true } | { searchQuery: string }

function toAction(call: LlmToolCall, requesterName?: string): ToolOperation {
  let parsed: unknown
  try { parsed = JSON.parse(call.arguments || '{}') } catch { throw new Error('工具参数不是有效 JSON') }
  const args = record(parsed)
  switch (call.name) {
    case 'observe_world': return 'observe'
    case 'follow_player_continuously': {
      const target = optionalText(args, 'player') ?? requesterName
      if (!target) throw new Error('持续跟随需要明确的玩家名')
      return { type: 'follow_player', target }
    }
    case 'return_home': return { type: 'return_home' }
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
    case 'step_on_block': return {
      type: 'step_on_block', x: whole(args, 'x', -30_000_000, 30_000_000), y: whole(args, 'y', -2048, 2048), z: whole(args, 'z', -30_000_000, 30_000_000)
    }
    case 'unequip_armor': return { type: 'unequip_armor' }
    case 'make_inventory_room': return { type: 'make_inventory_room', freeSlots: whole(args, 'free_slots', 1, 4) }
    case 'use_held_item': return { type: 'use_held_item', hand: args.hand === 'off' ? 'off' : 'main' }
    case 'eat_safe_food': return { type: 'eat_best_food' }
    case 'drop_inventory_item': return { type: 'drop_inventory_item', slot: whole(args, 'slot', 0, 35), count: whole(args, 'count', 1, 64) }
    case 'discard_worn_tools': return { type: 'discard_worn_tools', remainingDurability: whole(args, 'remaining_durability', 0, 16) }
    case 'craft_recipe': return { type: 'craft_recipe', itemId: text(args, 'item_id'), count: whole(args, 'count', 1, 64) }
    case 'gather_resource': return {
      type: 'gather_resource', resource: text(args, 'resource'), count: whole(args, 'count', 1, 64),
      verifiedWilderness: true, ...(requesterName ? { authorizedPlayer: requesterName } : {})
    }
    case 'craft_item': return { type: 'craft_item', itemId: text(args, 'item_id'), count: whole(args, 'count', 1, 64), verifiedWilderness: true }
    case 'smelt_items': return { type: 'smelt_item', inputItemId: text(args, 'input_item_id'), outputItemId: text(args, 'output_item_id'), count: whole(args, 'count', 1, 64) }
    case 'build_shelter': return { type: 'build_shelter', verifiedWilderness: true }
    case 'excavate_safely': return {
      type: 'excavate_tunnel', resource: text(args, 'resource'), targetY: whole(args, 'target_y', -2048, 2048),
      length: whole(args, 'length', 2, 64), verifiedWilderness: true
    }
    case 'return_to_task_start': return { returnToStart: true }
    case 'collect_own_drops': return { type: 'collect_own_drops', itemId: text(args, 'item_id'), count: whole(args, 'count', 1, 64), radius: whole(args, 'radius', 2, 32) }
    case 'give_item_to_player': return { type: 'drop_item', itemId: text(args, 'item_id'), count: whole(args, 'count', 1, 64), target: text(args, 'player') }
    case 'accept_items_from_player': {
      const itemId = text(args, 'item_id')
      return { type: 'accept_items', ...(itemId === 'any' ? {} : { itemId }), count: whole(args, 'count', 1, 64), target: text(args, 'player'), radius: whole(args, 'radius', 1, 6) }
    }
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

function compactWorldValue(world: WorldState, blockLimit = 16): Record<string, unknown> {
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
    nearbyPlayers: world.nearbyPlayers.slice(0, 8),
    nearbyHostiles: world.nearbyHostiles?.slice(0, 8),
    nearbyCreatures: world.nearbyCreatures?.slice(0, 8),
    nearbyItems: world.nearbyItems?.slice(0, 8),
    nearbyBlocks: world.nearbyBlocks?.slice(0, blockLimit),
    blockSurvey: survey ? {
      radius: survey.radius, verticalRadius: survey.verticalRadius, center: survey.center,
      classification: survey.classification, protectedLikely: survey.protectedLikely, reasons: survey.reasons.slice(0, 8),
      resources: survey.resources.slice(0, 10), artificial: survey.artificial.slice(0, 6),
      owned: survey.owned?.slice(0, 6), other: survey.other.slice(0, 6)
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

function compactWorld(world: WorldState, blockLimit = 16): string { return stringifyCompact(compactWorldValue(world, blockLimit)) }

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
    observation: compactWorldValue(current, 6)
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

type LedgerEntry = { step: number; tool: string; ok: boolean; detail: string; observation: unknown }

function textOnlyContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  const texts = value.flatMap(part => part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text'
    && typeof (part as Record<string, unknown>).text === 'string' ? [(part as { text: string }).text] : [])
  return texts.length > 0 ? texts.join('\n') : undefined
}

function compactLedgerObservation(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const delta = value as Record<string, unknown>
  const observation = delta.observation && typeof delta.observation === 'object'
    ? delta.observation as Record<string, unknown>
    : {}
  return {
    sequence: delta.sequence,
    position: delta.position,
    vitals: delta.vitals,
    inventoryChanges: delta.inventoryChanges,
    dimension: observation.dimension,
    selectedHotbarSlot: observation.selectedHotbarSlot,
    activePrimitive: observation.activePrimitive,
    navigationStatus: observation.navigationStatus
  }
}

const FOLLOWUP_SYSTEM = `继续上一轮 Minecraft Agent 任务。你已经读过完整人设、记忆和环境；现在只依据真实工具回执继续决策。
硬规则：每轮最多调用一个可用工具；成功只代表回执明确验证的后置条件，禁止编造成果；失败时按最新观察换方法，危险时停止；不得破坏玩家建筑、容器或未知财产，不主动攻击玩家；不得输出或索取密钥、令牌、服务器地址、本地路径和内部参数。
若目标已经满足，最终给游戏内玩家看的话必须且只能放在 <say>...</say> 中；标签外不得输出任何游戏可见内容。回复应自然、温柔、像真人队友，只给结果和自然交流，绝不复述工具名、参数、执行回执、思考、判断、计划、步骤、当前状态（如“持续跟随中”“正在靠近”“距离 X 格”）或你有哪些工具。若仍需动作则只调用下一项工具。`

function compactContinuationUser(userText: string | undefined): string {
  if (!userText) return '继续完成上一轮玩家目标。'
  const lines = userText.split('\n')
  const goalLine = lines.find(line => line.startsWith('目标：'))
  const requesterLine = lines.find(line => line.startsWith('发起玩家：') || line.startsWith('来源：'))
  let goal = goalLine?.slice('目标：'.length) ?? userText
  try {
    const parsed = JSON.parse(goal) as { playerMessage?: unknown; currentPlayer?: { name?: unknown } }
    goal = JSON.stringify({
      playerMessage: typeof parsed.playerMessage === 'string' ? parsed.playerMessage.slice(0, 1_000) : '',
      currentPlayer: { name: typeof parsed.currentPlayer?.name === 'string' ? parsed.currentPlayer.name.slice(0, 32) : '' }
    })
  } catch {
    goal = goal.slice(0, 1_200)
  }
  return [`仍需完成的原始目标：${goal}`, requesterLine ?? '', '完整上下文已在第一轮读取；结合进度账本和本轮工具回执继续。'].filter(Boolean).join('\n')
}

function compactContinuation(continuation: unknown, ledger: readonly LedgerEntry[]): unknown {
  if (!Array.isArray(continuation) || ledger.length === 0) return continuation
  const messages = continuation.filter((message): message is Record<string, unknown> => Boolean(message) && typeof message === 'object')
  const system = messages.find(message => message.role === 'system')
  const user = messages.find(message => message.role === 'user')
  const assistant = [...messages].reverse().find(message => message.role === 'assistant' && Array.isArray(message.tool_calls))
  if (!system || !user || !assistant) return continuation
  const userText = textOnlyContent(user.content)
  const progress = ledger.slice(-16).map(entry => ({
    step: entry.step, tool: entry.tool, ok: entry.ok, detail: entry.detail.slice(0, 400),
    observation: compactLedgerObservation(entry.observation)
  }))
  return [
    { ...system, content: FOLLOWUP_SYSTEM },
    { ...user, content: compactContinuationUser(userText) },
    { role: 'system', content: `执行进度账本（旧工具协议已压缩；下面均为真实回执，不能重复已完成步骤）：\n${JSON.stringify(progress)}` },
    assistant
  ]
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
  readonly #onToolSelected: ((event: ToolAgentSelectionEvent) => Promise<void> | void) | undefined
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
    onToolSelected?: (event: ToolAgentSelectionEvent) => Promise<void> | void
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
    this.#onToolSelected = options.onToolSelected
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
    let retriedEmptyToolResponse = false
    const executionLedger: LedgerEntry[] = []
    const taskStartY = input.initialWorld.position?.y
    let descended = false
    let passiveWaitStreak = 0
    const guideCache = new Map<string, string>()
    const tools = this.#searchGuide ? [...AGENT_TOOLS, GUIDE_SEARCH_TOOL] : [...AGENT_TOOLS]
    const user = [
      `目标：${input.goal}`,
      input.requesterName ? `发起玩家：${input.requesterName}` : '来源：空闲自主目标',
      '下面是起始观察。先决定策略；重复采集、挖掘、合成、熔炼、狩猎和返程应调用连续技能，让本地客户端完成低层动作。需要一直跟随时启动持续跟随技能，不能反复追逐玩家旧坐标。只有出现新情况、里程碑或失败才重新规划。每轮最多调用一个工具。',
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
      return result(false, '唔，我先停一下，不想傻乎乎地一直空耗下去。刚才做到哪里我都记住了，等条件合适再陪你接着试一次喵。', `${detail}${recovery}`)
    }

    for (let turn = 0; turn <= this.#maxSteps; turn++) {
      if (input.cancelled?.()) return result(false, '', 'cancelled')
      if (apiCalls >= this.#maxApiCalls) return stopForBudget(`agent_api_call_budget_exhausted:${this.#maxApiCalls}`)
      const request = {
        system: input.system,
        user,
        tools,
        ...(continuation === undefined ? {} : { continuation: compactContinuation(continuation, executionLedger) }),
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
      apiCalls++
      let response: LlmToolTurnResponse
      try {
        response = await this.#provider.toolTurn(request)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const failedUsage: LlmUsage = {
          inputTokens: estimatedInputTokens,
          outputTokens: this.#maxOutputTokens,
          totalTokens: estimatedInputTokens + this.#maxOutputTokens
        }
        cumulativeUsage = addUsage(cumulativeUsage, failedUsage)
        const effort = request.reasoningEffort ?? 'high'
        await this.#onTurn?.({
          apiCall: apiCalls, elapsedMs: Date.now() - callStarted, estimatedInputTokens, usage: failedUsage,
          cumulativeUsage, requestedEffort: effort, effectiveEffort: effort, estimated: true, error: detail
        })
        if (!retriedEmptyToolResponse && /模型既未调用工具，也未返回最终文本/u.test(detail) && apiCalls < this.#maxApiCalls) {
          retriedEmptyToolResponse = true
          turn--
          continue
        }
        throw error
      }
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
        cumulativeUsage, requestedEffort: response.requestedEffort, effectiveEffort: response.effectiveEffort,
        estimated: response.usage === undefined
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
          await this.#onToolSelected?.({ tool: call.name, arguments: call.arguments })
          const operation = toAction(call, input.requesterName)
          if (operation === 'observe') {
            ok = true
            detail = 'fresh_world_snapshot'
            passiveWaitStreak++
          } else if ('waitTicks' in operation) {
            await delay(operation.waitTicks * 50)
            ok = true
            detail = `waited_ticks=${operation.waitTicks}`
            passiveWaitStreak++
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
            passiveWaitStreak = 0
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
        executionLedger.push({ step: executedSteps, tool: call.name, ok, detail, observation })
        results.push({ callId: call.id, output: JSON.stringify({ ok, detail, observationDelta: observation }) })
        await this.#onStep?.({ step: executedSteps, tool: call.name, arguments: call.arguments, ok, detail, world })
        if (passiveWaitStreak >= 3) {
          return result(false, '唔，我在这儿傻等也不是办法，先停下来想想，等条件合适了再继续喵。', 'agent_passive_wait_streak_exhausted')
        }
      }
      toolResults = results
    }
    return stopForBudget(`agent_step_budget_exhausted:${this.#maxSteps}`)
  }
}
