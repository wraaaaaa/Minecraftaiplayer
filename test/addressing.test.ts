import assert from 'node:assert/strict'
import test from 'node:test'
import { AddressingEngine } from '../src/agent/addressing.js'
import type { WorldState } from '../src/agent/world-state.js'

const world: WorldState = { connected: true, inventory: [], nearbyPlayers: [{ name: 'Alice', distance: 3 }, { name: 'Bob', distance: 10 }] }

function engine(): AddressingEngine {
  return new AddressingEngine({ botNames: ['CialloAI', '小麦'], requireMention: true, contextual: true, directDistance: 8, conversationWindowMs: 60_000 })
}

test('显式名称、感叹号和最近玩家的直接命令均可寻址 Bot', () => {
  const addressing = engine()
  assert.equal(addressing.decide({ name: 'Alice' }, '@CialloAI 跟我来', world, 1000).addressed, true)
  assert.equal(addressing.decide({ name: 'Bob' }, '!停下', world, 1000).addressed, true)
  const contextual = addressing.decide({ name: 'Alice' }, '陪我去挖矿', world, 2000)
  assert.equal(contextual.addressed, true)
  assert.equal(contextual.confidence >= 0.8, true)
})

test('远处闲聊、明确叫别人和多人歧义不触发 Bot', () => {
  const addressing = engine()
  assert.equal(addressing.decide({ name: 'Bob' }, '今天天气不错', world, 1000).addressed, false)
  assert.equal(addressing.decide({ name: 'Alice' }, 'Bob 跟我来', world, 1000).addressed, false)
  const ambiguous: WorldState = { connected: true, inventory: [], nearbyPlayers: [{ name: 'Alice', distance: 7 }, { name: 'Bob', distance: 2 }] }
  assert.equal(addressing.decide({ name: 'Alice' }, '跟我来', ambiguous, 5000).addressed, false)
})

test('Bot 回复后的近距离对话可自然续接且 Bot 名会被去掉', () => {
  const addressing = engine()
  addressing.noteBotReply({ name: 'Alice', uuid: 'alice' }, 1000)
  const result = addressing.decide({ name: 'Alice', uuid: 'alice' }, '那我们现在走吧', world, 2000)
  assert.equal(result.addressed, true)
  assert.equal(addressing.decide({ name: 'Alice' }, '@小麦 过来', world, 3000).cleaned, '过来')
})

test('每位玩家在 USER.md 中约定的昵称和称号都可单独寻址 Bot', () => {
  const addressing = engine()
  const alice = addressing.decide({ name: 'Alice' }, '粉粉，陪我去挖矿', world, 1000, ['粉粉', '胆小鬼'])
  assert.equal(alice.addressed, true)
  assert.equal(alice.cleaned, '陪我去挖矿')
  assert.match(alice.evidence.join(' '), /粉粉/u)

  const bob = addressing.decide({ name: 'Bob' }, '粉粉，陪我去挖矿', world, 1000, ['小不点'])
  assert.equal(bob.addressed, false)
})
