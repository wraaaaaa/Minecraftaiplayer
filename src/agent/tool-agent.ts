import { setTimeout as delay } from 'node:timers/promises'
import type { LlmProvider, LlmToolCall, LlmToolDefinition, LlmToolResult } from '../llm/types.js'
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
}

export interface ToolAgentStepEvent {
  step: number
  tool: string
  arguments: string
  ok: boolean
  detail: string
  world: WorldState
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
 * The model only sees concrete, composable affordances. No entry represents a survival
 * workflow such as “gather wood”, “go mining” or “build a house”.
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
  { name: 'send_server_command', description: '尝试发送一个服务器命令。目前硬策略只允许“tp 玩家名”或“teleport 玩家名”，表示把 Bot 自己传送到该玩家；无权限时会返回失败，随后应改用正常寻路或向玩家说明。', parameters: objectSchema({ command: string('不带开头斜杠的命令') }) },
  { name: 'stop_all_actions', description: '立即释放移动和交互按键并停止当前动作。', parameters: objectSchema({}) },
  { name: 'wait_ticks', description: '原地等待少量游戏刻后重新观察。20 tick 约一秒。', parameters: objectSchema({ ticks: integer('等待 tick 数', 1, 100) }) }
])

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

function toAction(call: LlmToolCall, requesterName?: string): AgentAction | 'observe' | { waitTicks: number } {
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
    case 'send_server_command': return { type: 'send_server_command', command: text(args, 'command').replace(/^\/+/, '') }
    case 'stop_all_actions': return { type: 'stop' }
    case 'wait_ticks': return { waitTicks: whole(args, 'ticks', 1, 100) }
    default: throw new Error(`不存在工具 ${call.name}`)
  }
}

function compactWorld(world: WorldState): string {
  const compact = {
    ...world,
    nearbyBlocks: world.nearbyBlocks?.slice(0, 96),
    nearbyHostiles: world.nearbyHostiles?.slice(0, 24),
    nearbyCreatures: world.nearbyCreatures?.slice(0, 24),
    nearbyItems: world.nearbyItems?.slice(0, 24),
    nearbyPlayers: world.nearbyPlayers.slice(0, 24)
  }
  return JSON.stringify(compact, (_key, value) => typeof value === 'number' && !Number.isInteger(value) ? Number(value.toFixed(3)) : value)
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
  readonly #onStep: ((event: ToolAgentStepEvent) => Promise<void> | void) | undefined

  constructor(options: {
    provider: LlmProvider
    executor: ToolAgentExecutor
    authorize: (action: AgentAction) => PolicyDecision
    maxSteps?: number
    onStep?: (event: ToolAgentStepEvent) => Promise<void> | void
  }) {
    this.#provider = options.provider
    this.#executor = options.executor
    this.#authorize = options.authorize
    this.#maxSteps = Math.max(1, Math.min(128, options.maxSteps ?? 32))
    this.#onStep = options.onStep
  }

  async run(input: { system: string; goal: string; initialWorld: WorldState; requesterName?: string; cancelled?: () => boolean }): Promise<ToolAgentRunResult> {
    if (!this.#provider.toolTurn) throw new Error('当前模型适配器不支持原生工具调用，不能启动 Agent 闭环')
    let continuation: unknown
    let toolResults: LlmToolResult[] | undefined
    let world = input.initialWorld
    let model: string | undefined
    let executedSteps = 0
    const user = [
      `目标：${input.goal}`,
      input.requesterName ? `发起玩家：${input.requesterName}` : '来源：空闲自主目标',
      '下面是起始观察。你必须根据每次工具返回的真实结果逐步行动；每轮最多调用一个工具。不要预先假设后续动作成功。',
      compactWorld(world)
    ].join('\n')

    for (let turn = 0; turn <= this.#maxSteps; turn++) {
      if (input.cancelled?.()) return { ok: false, reply: '', steps: executedSteps, detail: 'cancelled', ...(model ? { model } : {}) }
      const response = await this.#provider.toolTurn({
        system: input.system,
        user,
        tools: [...AGENT_TOOLS],
        ...(continuation === undefined ? {} : { continuation: compactOldToolResults(continuation) }),
        ...(toolResults === undefined ? {} : { toolResults })
      })
      model = response.model
      continuation = response.continuation
      toolResults = undefined
      if (response.toolCalls.length === 0) {
        return {
          ok: true,
          reply: response.text.trim(),
          steps: executedSteps,
          detail: executedSteps === 0 ? 'chat_only' : `agent_completed_after_${executedSteps}_tools`,
          model
        }
      }
      if (turn === this.#maxSteps) break

      const results: LlmToolResult[] = []
      // parallel_tool_calls=false is requested. If a provider still emits more than one,
      // execute only the first and explicitly return skipped results for protocol integrity.
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
          } else {
            const policy = this.#authorize(operation)
            if (!policy.allowed) detail = `policy_denied: ${policy.reason}`
            else {
              const outcome = await this.#executor.execute(operation)
              ok = outcome.ok
              detail = outcome.detail
              // The Fabric state stream is one snapshot per second. Give the server and
              // encoder a short chance to expose a postcondition before replanning.
              await delay(350)
            }
          }
        } catch (error) {
          detail = error instanceof Error ? error.message : String(error)
        }
        if (call.name !== 'observe_world') executedSteps++
        world = this.#executor.snapshot?.() ?? world
        const output = `{"ok":${ok},"detail":${JSON.stringify(detail)},"world":${compactWorld(world)}}`
        results.push({ callId: call.id, output })
        await this.#onStep?.({ step: executedSteps, tool: call.name, arguments: call.arguments, ok, detail, world })
      }
      toolResults = results
    }
    return { ok: false, reply: '这件事比我这一轮能安全完成的步骤更长，我先停下来重新整理。', steps: executedSteps, detail: `agent_step_budget_exhausted:${this.#maxSteps}`, ...(model ? { model } : {}) }
  }
}
