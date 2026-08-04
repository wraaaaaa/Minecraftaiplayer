import assert from 'node:assert/strict'
import test from 'node:test'
import type { BehaviorRules } from '../src/config/types.js'
import { PolicyEngine } from '../src/policy/policy-engine.js'

const rules: BehaviorRules = {
  version: 1,
  denyBreakingPlayerProperty: true,
  denyOpeningPlayerContainers: true,
  denyTakingPlayerItems: true,
  wildernessDevelopmentOnly: true,
  allowSelfDefense: true,
  selfDefenseWindowMs: 15000,
  stopSelfDefenseWhenThreatEnds: true,
  allowPlayerOrderedPvp: false,
  allowDestructiveActionsWhenOwnershipUnknown: false,
  proactiveChat: { enabled: true, avoidSecrets: true, avoidSpam: true }
}

test('禁止破坏玩家财产、未知归属和没有可信证据的所谓自然方块', () => {
  const policy = new PolicyEngine(rules)
  assert.equal(policy.authorize({ type: 'break_block', block: 'stone', ownership: 'player' }).allowed, false)
  assert.equal(policy.authorize({ type: 'break_block', block: 'stone', ownership: 'unknown' }).allowed, false)
  assert.equal(policy.authorize({ type: 'break_block', block: 'stone', ownership: 'natural' }).allowed, false)
  assert.equal(policy.authorize({ type: 'break_block', block: 'stone', ownership: 'natural', evidence: 'fabric_verified_zone' }).allowed, true)
})

test('只允许在有效窗口内对实际攻击者自卫', () => {
  const policy = new PolicyEngine(rules)
  const now = 100000
  assert.equal(policy.authorize({ type: 'attack_player', target: 'Alice' }, now).allowed, false)
  policy.noteAttack('Alice', now)
  assert.equal(policy.authorize({ type: 'attack_player', target: 'Alice' }, now + 1000).allowed, true)
  assert.equal(policy.authorize({ type: 'attack_player', target: 'Bob' }, now + 1000).allowed, false)
  assert.equal(policy.authorize({ type: 'attack_player', target: 'Alice' }, now + 16000).allowed, false)
})
