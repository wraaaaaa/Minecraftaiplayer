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
