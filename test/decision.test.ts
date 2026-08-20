import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAgentDecision } from '../src/agent/decision.js'

test('解析模型 JSON 并限制聊天和闲逛半径', () => {
  const decision = parseAgentDecision('```json\n{"reply":"我来了！\\n马上到。","action":{"type":"wander","radius":99},"remember":"Alice 喜欢建造"}\n```')
  assert.equal(decision.reply, '我来了！ 马上到。')
  assert.deepEqual(decision.action, { type: 'wander', radius: 8 })
  assert.equal(decision.remember, 'Alice 喜欢建造')
  assert.equal(decision.intent, 'action')
})

test('显式聊天意图不会因句中动作词或错误附带动作而调用工具', () => {
  const decision = parseAgentDecision(JSON.stringify({
    intent: 'chat',
    reply: '钻石运气不错呀，下次带我一起看看喵~',
    action: { type: 'gather_resource', resource: 'diamond', count: 64 },
    actions: [{ type: 'excavate_tunnel', targetY: -53, length: 64 }]
  }))
  assert.equal(decision.intent, 'chat')
  assert.deepEqual(decision.action, { type: 'none' })
  assert.equal(decision.actions, undefined)
  assert.equal(decision.validationError, undefined)
})

test('没有显式 intent 的旧模型输出按实际动作保持兼容', () => {
  assert.equal(parseAgentDecision('{"reply":"嗯，我在听。","action":{"type":"none"}}').intent, 'chat')
  assert.equal(parseAgentDecision('{"reply":"来了","action":{"type":"come_to_player","target":"Alice"}}').intent, 'action')
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

test('模型可以返回有上限且逐步规范化的工具计划', () => {
  const decision = parseAgentDecision(JSON.stringify({
    reply: '我分步完成。',
    actions: [
      { type: 'come_to_player' },
      { type: 'drop_item', itemId: 'minecraft:baked_potato', count: 2 }
    ]
  }), { currentPlayerName: 'Alice' })
  assert.deepEqual(decision.actions, [
    { type: 'come_to_player', target: 'Alice' },
    { type: 'drop_item', itemId: 'minecraft:baked_potato', count: 2, target: 'Alice' }
  ])
  assert.deepEqual(decision.action, { type: 'come_to_player', target: 'Alice' })
})

test('高级生存动作会被严格规范化且模型不能伪造荒野许可', () => {
  const parsed = parseAgentDecision(JSON.stringify({ actions: [
    { type: 'hunt_entity', purpose: 'food', count: 3 },
    { type: 'smelt_item', inputItemId: 'minecraft:beef', outputItemId: 'minecraft:cooked_beef', count: 3 },
    { type: 'excavate_tunnel', resource: 'diamond', targetY: -53, length: 12, verifiedWilderness: true },
    { type: 'travel_to_dimension', dimension: 'minecraft:the_end' }
  ] }))
  assert.deepEqual(parsed.actions, [
    { type: 'hunt_entity', purpose: 'food', count: 3 },
    { type: 'smelt_item', inputItemId: 'minecraft:beef', outputItemId: 'minecraft:cooked_beef', count: 3 },
    { type: 'excavate_tunnel', resource: 'diamond', targetY: -53, length: 12 },
    { type: 'travel_to_dimension', dimension: 'minecraft:the_end' }
  ])
})
