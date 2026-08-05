import assert from 'node:assert/strict'
import test from 'node:test'
import { assessAction } from '../src/agent/capability-assessor.js'
import type { WorldState } from '../src/agent/world-state.js'
import type { BotConfig } from '../src/config/types.js'

const config = {
  server: { adapter: 'fabric_bridge', connectionMode: 'direct', host: 'example.invalid', port: 25565, lanDiscoveryTimeoutMs: 8000, version: '26.2', username: 'CialloAI', auth: 'offline', connectTimeoutMs: 30000, reconnectDelayMs: 10000, bridgeHost: '127.0.0.1', bridgePort: 8765, actionTimeoutMs: 10000 },
  easyAuth: { enabled: false, registerIfNeeded: false, passwordEnv: 'MINECRAFT_LOGIN_PASSWORD', loginDelayMs: 0 },
  model: { provider: 'deepseek', model: 'mock', apiKeyEnv: 'TEST_KEY', baseUrl: 'https://example.invalid', reasoningEffort: 'low', timeoutMs: 5000 },
  chat: { requireMention: true, replyPrefix: '', cooldownMs: 0, proactiveEnabled: false, proactiveIdleMs: 1000, proactiveMinIntervalMs: 1000 },
  storage: { memoryFile: 'data/memory.json', experienceFile: 'data/experience.json', maxEvents: 10 },
  policyFile: 'config/behavior-rules.json', personaFile: 'config/persona.json', promptsFile: 'config/prompts.json', logging: { file: 'logs/test.log', level: 'error', console: false }
} satisfies BotConfig

function endWorld(enchanted: boolean): WorldState {
  return {
    connected: true,
    inventory: [{ name: '熟牛排', itemId: 'minecraft:cooked_beef', count: 20 }],
    nearbyPlayers: [],
    equipment: Object.fromEntries(['head', 'chest', 'legs', 'feet'].map(slot => [slot, { itemId: `minecraft:golden_${slot === 'head' ? 'helmet' : slot === 'chest' ? 'chestplate' : slot === 'legs' ? 'leggings' : 'boots'}`, name: '黄金护甲', count: 1, enchanted }]).concat([['mainHand', { itemId: 'minecraft:golden_sword', name: '金剑', count: 1, enchanted }]]))
  }
}

test('末地战斗要求附魔黄金等效装备与食物', () => {
  assert.equal(assessAction(config, { type: 'equip_best', purpose: 'end_combat' }, endWorld(true)).status, 'ready')
  const weak = assessAction(config, { type: 'equip_best', purpose: 'end_combat' }, endWorld(false))
  assert.equal(weak.status, 'needs_preparation')
  assert.match(weak.reasons.join('；'), /附魔黄金/u)

  const bestOwned = endWorld(true)
  bestOwned.equipment!.mainHand = { itemId: 'minecraft:wooden_sword', name: '木剑', count: 1, enchanted: false }
  bestOwned.inventory.push({ name: '钻石剑', itemId: 'minecraft:diamond_sword', count: 1 })
  assert.equal(assessAction(config, { type: 'prepare_for', purpose: 'end_combat' }, bestOwned).status, 'ready')

  const unsafeFood = endWorld(true)
  unsafeFood.inventory = [{ name: '毒马铃薯', itemId: 'minecraft:poisonous_potato', count: 64 }]
  assert.match(assessAction(config, { type: 'prepare_for', purpose: 'end_combat' }, unsafeFood).reasons.join('；'), /安全食物/u)
})

test('敌对目标和食物缺失时给出可操作的阻塞原因', () => {
  const world: WorldState = { connected: true, inventory: [], nearbyPlayers: [], nearbyHostiles: [] }
  assert.equal(assessAction(config, { type: 'attack_hostile' }, world).status, 'blocked')
  assert.equal(assessAction(config, { type: 'eat_best_food' }, world).status, 'blocked')
})

test('Node 只决定能力开关，实际目标和玩家距离由 Fabric 逐格验证', () => {
  const enabled: BotConfig = structuredClone(config)
  enabled.autonomy = {
    enabled: true, ownerName: 'wraaaaaa', commandArbitrationMs: 350, contextualAddressing: true,
    directAddressDistance: 8, conversationWindowMs: 60_000, lowHealthThreshold: 10,
    criticalHealthThreshold: 6, eatBelowFood: 16, hostileScanRadius: 12,
    wildernessMinPlayerDistance: 48, safeIdleEnabled: true, autoGather: true, autoCraft: true,
    autoBuildShelter: true,
    developmentZone: { enabled: true, dimension: 'minecraft:overworld', minX: -32, minY: 40, minZ: -32, maxX: 32, maxY: 100, maxZ: 32 }
  }
  const crowded: WorldState = { connected: true, inventory: [], nearbyPlayers: [{ name: 'Alice', distance: 20 }] }
  const empty: WorldState = { connected: true, inventory: [], nearbyPlayers: [] }
  assert.equal(assessAction(enabled, { type: 'gather_resource', resource: 'wood', count: 1 }, crowded).status, 'ready')
  assert.equal(assessAction(enabled, { type: 'gather_resource', resource: 'wood', count: 1 }, crowded, { requesterName: 'Alice' }).status, 'ready')
  assert.equal(assessAction(enabled, { type: 'gather_resource', resource: 'wood', count: 1 }, { ...crowded, nearbyPlayers: [{ name: 'wraaaaaa', distance: 2 }] }, { requesterName: 'wraaaaaa' }).status, 'ready')
  assert.equal(assessAction(enabled, { type: 'gather_resource', resource: 'wood', count: 1 }, { ...crowded, nearbyPlayers: [{ name: 'wraaaaaa', distance: 2 }, { name: 'Bob', distance: 10 }] }, { requesterName: 'wraaaaaa' }).status, 'ready')
  assert.equal(assessAction(enabled, { type: 'build_shelter' }, crowded).status, 'ready')
  assert.equal(assessAction(enabled, { type: 'gather_resource', resource: 'wood', count: 1 }, empty).status, 'ready')
})
