import assert from 'node:assert/strict'
import test from 'node:test'
import { ToolAgent } from '../src/agent/tool-agent.js'
import type { WorldState } from '../src/agent/world-state.js'
import type { LlmProvider, LlmToolTurnResponse } from '../src/llm/types.js'
import type { AgentAction } from '../src/policy/policy-engine.js'

const initial: WorldState = {
  connected: true,
  position: { x: 0, y: 64, z: 0 },
  health: 20,
  food: 20,
  inventory: [],
  nearbyPlayers: [{ name: 'Alice', distance: 3, position: { x: 3, y: 64, z: 0 } }]
}

function turns(...responses: LlmToolTurnResponse[]): LlmProvider {
  let index = 0
  return {
    complete: async () => { throw new Error('Agent 闭环不应调用旧 JSON complete') },
    toolTurn: async () => responses[index++] ?? { text: '结束', toolCalls: [], model: 'mock', requestedEffort: 'high', effectiveEffort: 'high' }
  }
}

test('每个工具结果都带着最新观察回到模型，再由模型决定下一步', async () => {
  const provider = turns(
    { text: '', toolCalls: [{ id: 'a', name: 'navigate_to', arguments: '{"x":2,"y":64,"z":0,"stop_distance":1}' }], continuation: { turn: 1 }, model: 'mock', requestedEffort: 'high', effectiveEffort: 'high' },
    { text: '', toolCalls: [{ id: 'b', name: 'look_at', arguments: '{"x":3,"y":65.6,"z":0}' }], continuation: { turn: 2 }, model: 'mock', requestedEffort: 'high', effectiveEffort: 'high' },
    { text: '我过来了。', toolCalls: [], model: 'mock', requestedEffort: 'high', effectiveEffort: 'high' }
  )
  const actions: AgentAction[] = []
  let world = structuredClone(initial)
  const result = await new ToolAgent({
    provider,
    executor: {
      execute: async action => {
        actions.push(action)
        if (action.type === 'navigate_to') world = { ...world, position: { x: 2, y: 64, z: 0 } }
        return { ok: true, detail: `verified:${action.type}` }
      },
      chat: async () => {},
      snapshot: () => structuredClone(world)
    },
    authorize: () => ({ allowed: true, reason: 'test' }),
    maxSteps: 8
  }).run({ system: 'system', goal: '走到 Alice 面前', initialWorld: initial })
  assert.deepEqual(actions.map(action => action.type), ['navigate_to', 'look_at'])
  assert.equal(result.ok, true)
  assert.equal(result.reply, '我过来了。')
  assert.equal(result.steps, 2)
})

test('模型可自主选择回家与接收玩家物品接口', async () => {
  const provider = turns(
    { text: '', toolCalls: [{ id: 'home', name: 'return_home', arguments: '{}' }], continuation: { turn: 1 }, model: 'mock', requestedEffort: 'high', effectiveEffort: 'high' },
    { text: '', toolCalls: [{ id: 'receive', name: 'accept_items_from_player', arguments: '{"player":"Alice","item_id":"minecraft:iron_chestplate","count":1,"radius":3}' }], continuation: { turn: 2 }, model: 'mock', requestedEffort: 'none', effectiveEffort: 'none' },
    { text: '我收好啦。', toolCalls: [], model: 'mock', requestedEffort: 'none', effectiveEffort: 'none' }
  )
  const actions: AgentAction[] = []
  const result = await new ToolAgent({
    provider,
    executor: { execute: async action => { actions.push(action); return { ok: true, detail: `verified:${action.type}` } }, chat: async () => {}, snapshot: () => initial },
    authorize: () => ({ allowed: true, reason: 'test' }), maxSteps: 4
  }).run({ system: 'system', goal: '回家后收下 Alice 的胸甲', initialWorld: initial, requesterName: 'Alice' })
  assert.equal(result.ok, true)
  assert.deepEqual(actions, [
    { type: 'return_home' },
    { type: 'accept_items', itemId: 'minecraft:iron_chestplate', count: 1, target: 'Alice', radius: 3 }
  ])
})

test('建房、进食和磨损工具清理都映射为一次客户端技能', async () => {
  const provider = turns(
    { text: '', toolCalls: [{ id: 'eat', name: 'eat_safe_food', arguments: '{}' }], continuation: { turn: 1 }, model: 'mock', requestedEffort: 'high', effectiveEffort: 'high' },
    { text: '', toolCalls: [{ id: 'clean', name: 'discard_worn_tools', arguments: '{"remaining_durability":1}' }], continuation: { turn: 2 }, model: 'mock', requestedEffort: 'none', effectiveEffort: 'none' },
    { text: '', toolCalls: [{ id: 'house', name: 'build_shelter', arguments: '{}' }], continuation: { turn: 3 }, model: 'mock', requestedEffort: 'none', effectiveEffort: 'none' },
    { text: '<say>吃饱也收好背包啦，小屋我会一口气搭完喵~</say>', toolCalls: [], model: 'mock', requestedEffort: 'none', effectiveEffort: 'none' }
  )
  const actions: AgentAction[] = []
  const result = await new ToolAgent({
    provider,
    executor: { execute: async action => { actions.push(action); return { ok: true, detail: `verified:${action.type}` } }, chat: async () => {}, snapshot: () => initial },
    authorize: () => ({ allowed: true, reason: 'test' }), maxSteps: 6
  }).run({ system: 'system', goal: '吃点东西清背包再建一个小屋', initialWorld: initial })
  assert.equal(result.ok, true)
  assert.deepEqual(actions, [
    { type: 'eat_best_food' },
    { type: 'discard_worn_tools', remainingDurability: 1 },
    { type: 'build_shelter', verifiedWilderness: true }
  ])
})

test('一个工具失败后不会继续旧计划，而是把失败交还模型重新规划', async () => {
  const requests: unknown[] = []
  const provider: LlmProvider = {
    complete: async () => { throw new Error('unexpected') },
    toolTurn: async request => {
      requests.push(request)
      if (requests.length === 1) return { text: '', toolCalls: [{ id: 'a', name: 'send_server_command', arguments: '{"command":"tp Alice"}' }], continuation: 'c1', model: 'mock', requestedEffort: 'high', effectiveEffort: 'high' }
      return { text: '我没有传送权限，只能正常赶过去。', toolCalls: [], continuation: 'c2', model: 'mock', requestedEffort: 'high', effectiveEffort: 'high' }
    }
  }
  const result = await new ToolAgent({
    provider,
    executor: { execute: async () => ({ ok: false, detail: 'permission_denied: command tp requires permission level 2' }), chat: async () => {}, snapshot: () => initial },
    authorize: () => ({ allowed: true, reason: 'test' }), maxSteps: 4
  }).run({ system: 'system', goal: '传送到 Alice', initialWorld: initial })
  const second = requests[1] as { toolResults?: Array<{ output: string }> }
  assert.match(second.toolResults?.[0]?.output ?? '', /permission_denied/u)
  assert.equal(result.reply, '我没有传送权限，只能正常赶过去。')
})

test('模型可选择安全挖掘技能，一次工具调用连续完成多格而不是逐方块请求模型', async () => {
  let providerCalls = 0
  const provider: LlmProvider = {
    complete: async () => { throw new Error('unexpected') },
    toolTurn: async () => {
      providerCalls++
      if (providerCalls === 1) return {
        text: '',
        toolCalls: [{ id: 'mine-1', name: 'excavate_safely', arguments: '{"resource":"diamond_ore","target_y":-53,"length":48}' }],
        continuation: [{ role: 'assistant' }], model: 'mock', requestedEffort: 'high', effectiveEffort: 'high',
        usage: { inputTokens: 800, outputTokens: 60, totalTokens: 860 }
      }
      return {
        text: '我已经沿着安全阶梯挖到目标高度了。', toolCalls: [], model: 'mock',
        requestedEffort: 'none', effectiveEffort: 'none', usage: { inputTokens: 300, outputTokens: 20, totalTokens: 320 }
      }
    }
  }
  const actions: AgentAction[] = []
  const result = await new ToolAgent({
    provider,
    executor: {
      execute: async action => { actions.push(action); return { ok: true, detail: 'verified_tunnel_steps=48; inventory_delta=1' } },
      chat: async () => {}, snapshot: () => initial
    },
    authorize: () => ({ allowed: true, reason: 'test' }), maxSteps: 8, maxApiCalls: 4, maxTaskTokens: 10_000
  }).run({ system: 'system', goal: '挖一个钻石', initialWorld: initial })
  assert.equal(providerCalls, 2)
  assert.deepEqual(actions, [{ type: 'excavate_tunnel', resource: 'diamond_ore', targetY: -53, length: 48, verifiedWilderness: true }])
  assert.equal(result.steps, 1)
  assert.equal(result.apiCalls, 2)
  assert.equal(result.usage.totalTokens, 1180)
})

test('任务 Token 硬预算会在下一次请求前停止，避免失控循环', async () => {
  let providerCalls = 0
  const provider: LlmProvider = {
    complete: async () => { throw new Error('unexpected') },
    toolTurn: async () => {
      providerCalls++
      return {
        text: '', toolCalls: [{ id: `wait-${providerCalls}`, name: 'wait_ticks', arguments: '{"ticks":1}' }],
        continuation: [], model: 'mock', requestedEffort: 'high', effectiveEffort: 'high',
        usage: { inputTokens: 900, outputTokens: 100, totalTokens: 1000 }
      }
    }
  }
  const result = await new ToolAgent({
    provider,
    executor: { execute: async () => ({ ok: true, detail: 'ok' }), chat: async () => {}, snapshot: () => initial },
    authorize: () => ({ allowed: true, reason: 'test' }), maxSteps: 20, maxApiCalls: 20, maxTaskTokens: 1_500, maxOutputTokens: 128,
    estimateTokens: () => 600
  }).run({ system: 'system', goal: '等待', initialWorld: initial })
  assert.equal(providerCalls, 1)
  assert.equal(result.ok, false)
  assert.match(result.detail, /agent_token_budget_exhausted/u)
  assert.equal(result.usage.totalTokens, 1000)
})

test('模型可启动持续跟随技能而不是反复追逐静态坐标', async () => {
  const actions: AgentAction[] = []
  const provider = turns(
    {
      text: '', toolCalls: [{ id: 'follow-1', name: 'follow_player_continuously', arguments: '{"player":"Alice"}' }],
      continuation: [{ role: 'assistant', tool_calls: [{ id: 'follow-1' }] }], model: 'mock', requestedEffort: 'high', effectiveEffort: 'high'
    },
    { text: '好呀，我会一直跟着你，想停的时候和我说一声就好喵~', toolCalls: [], model: 'mock', requestedEffort: 'none', effectiveEffort: 'none' }
  )
  const result = await new ToolAgent({
    provider,
    executor: { execute: async action => { actions.push(action); return { ok: true, detail: 'continuous_follow_started' } }, chat: async () => {}, snapshot: () => initial },
    authorize: () => ({ allowed: true, reason: 'test' }), maxSteps: 4
  }).run({ system: 'system', goal: '一直跟着 Alice', initialWorld: initial, requesterName: 'Alice' })
  assert.deepEqual(actions, [{ type: 'follow_player', target: 'Alice' }])
  assert.equal(result.ok, true)
  assert.match(result.reply, /一直跟着/u)
})

test('模型第一次选择游戏工具时先触发开工回应，再执行实际动作', async () => {
  const order: string[] = []
  const provider = turns(
    { text: '', toolCalls: [{ id: 'mine', name: 'break_block', arguments: '{"x":1,"y":64,"z":0,"expected_block_id":"minecraft:stone"}' }], model: 'mock', requestedEffort: 'high', effectiveEffort: 'high' },
    { text: '挖好啦。', toolCalls: [], model: 'mock', requestedEffort: 'none', effectiveEffort: 'none' }
  )
  await new ToolAgent({
    provider,
    executor: { execute: async () => { order.push('execute'); return { ok: true, detail: 'block_broken' } }, chat: async () => {}, snapshot: () => initial },
    authorize: () => ({ allowed: true, reason: 'test' }),
    onToolSelected: async event => { order.push(`ack:${event.tool}`) },
    maxSteps: 4
  }).run({ system: 'system', goal: '挖掉脚边石头', initialWorld: initial })
  assert.deepEqual(order, ['ack:break_block', 'execute'])
})

test('Chat Completions 仅保留最近工具协议并用紧凑账本承接旧步骤', async () => {
  const requests: Array<{ continuation?: unknown; toolResults?: unknown }> = []
  const provider: LlmProvider = {
    complete: async () => { throw new Error('unexpected') },
    toolTurn: async request => {
      requests.push(request)
      if (requests.length === 1) return {
        text: '', toolCalls: [{ id: 'craft-2', name: 'craft_recipe', arguments: '{"item_id":"minecraft:stick","count":8}' }],
        continuation: [
          { role: 'system', content: 'very long system '.repeat(2_000) },
          { role: 'user', content: `目标：${JSON.stringify({ playerMessage: '做十个石镐', currentPlayer: { name: 'Alice', conversationSummary: 'old '.repeat(2_000) } })}\n发起玩家：Alice\n下面是起始观察。\n${'world '.repeat(2_000)}` },
          { role: 'assistant', reasoning_content: 'old reasoning', tool_calls: [{ id: 'old-1' }] },
          { role: 'tool', tool_call_id: 'old-1', content: '{"ok":true,"detail":"old large result"}' },
          { role: 'assistant', reasoning_content: 'current reasoning', tool_calls: [{ id: 'craft-2' }] }
        ],
        model: 'mock', requestedEffort: 'high', effectiveEffort: 'high'
      }
      return { text: '木棍做好了，接下来继续做石镐喵~', toolCalls: [], model: 'mock', requestedEffort: 'none', effectiveEffort: 'none' }
    }
  }
  await new ToolAgent({
    provider,
    executor: { execute: async () => ({ ok: true, detail: 'verified_crafted_count=8' }), chat: async () => {}, snapshot: () => initial },
    authorize: () => ({ allowed: true, reason: 'test' }), maxSteps: 4
  }).run({ system: 'system', goal: '做十个石镐', initialWorld: initial })
  const compacted = requests[1]?.continuation as Array<{ role?: string; content?: string; reasoning_content?: string }>
  assert.ok(Array.isArray(compacted))
  assert.equal(compacted.some(message => message.reasoning_content === 'old reasoning'), false)
  assert.equal(compacted.some(message => message.reasoning_content === 'current reasoning'), true)
  const ledger = compacted.find(message => message.role === 'system' && message.content?.includes('执行进度账本'))?.content ?? ''
  assert.match(ledger, /craft_recipe.*verified_crafted_count=8/u)
  assert.doesNotMatch(ledger, /nearbyBlocks|nearbyHostiles|blockSurvey/u)
  assert.ok(compacted.length <= 4)
  const compactSystem = compacted.find(message => message.role === 'system' && !message.content?.includes('执行进度账本'))?.content ?? ''
  const compactUser = compacted.find(message => message.role === 'user')?.content ?? ''
  assert.ok(compactSystem.length < 1_500)
  assert.ok(compactUser.length < 1_500)
  assert.match(compactUser, /做十个石镐/u)
  assert.doesNotMatch(compactUser, /conversationSummary|world world/u)
})

test('DeepSeek 空工具响应只降级重试一次且计入 API 与 Token 预算', async () => {
  let providerCalls = 0
  const requests: Array<{ reasoningEffort?: string }> = []
  const provider: LlmProvider = {
    complete: async () => { throw new Error('unexpected') },
    toolTurn: async request => {
      providerCalls++
      requests.push(request)
      if (providerCalls === 1) throw new Error('模型既未调用工具，也未返回最终文本')
      return { text: '唔，刚才走神了一下。现在看清楚啦，我们继续吧喵~', toolCalls: [], model: 'mock', requestedEffort: 'none', effectiveEffort: 'none', usage: { inputTokens: 200, outputTokens: 30, totalTokens: 230 } }
    }
  }
  const result = await new ToolAgent({
    provider,
    executor: { execute: async () => ({ ok: true, detail: 'ok' }), chat: async () => {}, snapshot: () => initial },
    authorize: () => ({ allowed: true, reason: 'test' }), maxSteps: 4, maxApiCalls: 3, maxTaskTokens: 20_000,
    maxOutputTokens: 256, estimateTokens: () => 500
  }).run({ system: 'system', goal: '离开这里', initialWorld: initial })
  assert.equal(providerCalls, 2)
  assert.equal(requests[1]?.reasoningEffort, 'none')
  assert.equal(result.apiCalls, 2)
  assert.equal(result.usage.totalTokens, 500 + 256 + 230)
  assert.equal(result.ok, true)
})

test('模型连续空转观察与等待会提前停止，不会耗尽 API 预算', async () => {
  let providerCalls = 0
  const provider: LlmProvider = {
    complete: async () => { throw new Error('unexpected') },
    toolTurn: async () => {
      providerCalls++
      const passive = providerCalls % 2 === 1
        ? { id: `observe-${providerCalls}`, name: 'observe_world', arguments: '{}' }
        : { id: `wait-${providerCalls}`, name: 'wait_ticks', arguments: '{"ticks":20}' }
      return { text: '', toolCalls: [passive], model: 'mock', requestedEffort: 'none', effectiveEffort: 'none' }
    }
  }
  const result = await new ToolAgent({
    provider,
    executor: { execute: async () => ({ ok: true, detail: 'ok' }), chat: async () => {}, snapshot: () => initial },
    authorize: () => ({ allowed: true, reason: 'test' }), maxSteps: 20, maxApiCalls: 20
  }).run({ system: 'system', goal: '穿装备', initialWorld: initial })
  assert.equal(result.ok, false)
  assert.match(result.detail, /agent_passive_wait_streak_exhausted/u)
  assert.ok(providerCalls < 8, `提前停止而非耗尽预算，实际调用 ${providerCalls}`)
})
