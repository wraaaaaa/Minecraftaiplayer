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
