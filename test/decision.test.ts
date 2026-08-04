import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAgentDecision } from '../src/agent/decision.js'

test('解析模型 JSON 并限制聊天和闲逛半径', () => {
  const decision = parseAgentDecision('```json\n{"reply":"我来了！\\n马上到。","action":{"type":"wander","radius":99},"remember":"Alice 喜欢建造"}\n```')
  assert.equal(decision.reply, '我来了！ 马上到。')
  assert.deepEqual(decision.action, { type: 'wander', radius: 16 })
  assert.equal(decision.remember, 'Alice 喜欢建造')
})

test('未知或缺参动作降级为 none', () => {
  assert.deepEqual(parseAgentDecision('{"reply":"好的","action":{"type":"follow_player"}}').action, { type: 'none' })
  assert.deepEqual(parseAgentDecision('{"reply":"好的","action":{"type":"teleport"}}').action, { type: 'none' })
})

test('玩家移动动作漏写 target 时安全使用当前发令玩家', () => {
  assert.deepEqual(
    parseAgentDecision('{"reply":"来了","action":{"type":"come_to_player"}}', { currentPlayerName: 'wraaaaaa' }).action,
    { type: 'come_to_player', target: 'wraaaaaa' }
  )
  assert.deepEqual(
    parseAgentDecision('{"reply":"不行","action":{"type":"attack_player"}}', { currentPlayerName: 'wraaaaaa' }).action,
    { type: 'none' }
  )
})

test('把玩家语义的破坏和挖掘动作归一化为受保护采集', () => {
  assert.deepEqual(
    parseAgentDecision('{"reply":"我去挖石头。","action":{"type":"break_block","block":"minecraft:stone","count":3,"ownership":"natural"}}').action,
    { type: 'gather_resource', resource: 'minecraft:stone', count: 3 }
  )
  assert.deepEqual(
    parseAgentDecision('{"reply":"我来采。","action":{"type":"mine_block","resource":"iron","count":2}}').action,
    { type: 'gather_resource', resource: 'iron', count: 2 }
  )
  assert.equal(
    parseAgentDecision('{"reply":"我来挖。","action":{"type":"break_natural_block"}}').validationError,
    'break_natural_block 缺少 resource 或 block'
  )
})
