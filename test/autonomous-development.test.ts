import assert from 'node:assert/strict'
import test from 'node:test'
import { planAutonomousDevelopment } from '../src/agent/autonomous-development.js'
import { DEFAULT_AUTONOMY_CONFIG, type BotConfig } from '../src/config/types.js'
import type { WorldState } from '../src/agent/world-state.js'

const config = {
  server: { adapter: 'fabric_bridge', connectionMode: 'direct', host: 'example.invalid', port: 25565, lanDiscoveryTimeoutMs: 8000, version: '26.2', username: 'Bot', auth: 'offline', connectTimeoutMs: 1000, reconnectDelayMs: 1000, bridgeHost: '127.0.0.1', bridgePort: 8765, actionTimeoutMs: 1000 },
  easyAuth: { enabled: false, registerIfNeeded: false, passwordEnv: 'LOGIN', loginDelayMs: 0 },
  model: { provider: 'deepseek', model: 'mock', apiKeyEnv: 'KEY', baseUrl: 'https://example.invalid', reasoningEffort: 'low', timeoutMs: 1000 },
  chat: { requireMention: false, replyPrefix: '', cooldownMs: 0, proactiveEnabled: false, proactiveIdleMs: 1000, proactiveMinIntervalMs: 1000 },
  storage: { memoryFile: 'memory.json', experienceFile: 'experience.json', maxEvents: 10 },
  policyFile: 'rules.json', personaFile: 'persona.json', promptsFile: 'prompts.json', logging: { file: 'bot.log', level: 'error', console: false },
  autonomy: { ...DEFAULT_AUTONOMY_CONFIG, enabled: true, autoGather: true, autoCraft: true, developmentZone: { enabled: true, dimension: 'minecraft:overworld', minX: 0, minY: 60, minZ: 0, maxX: 10, maxY: 70, maxZ: 10 } }
} satisfies BotConfig

function surveyed(inventory: WorldState['inventory'] = []): WorldState {
  return { connected: true, dimension: 'minecraft:overworld', position: { x: 5, y: 64, z: 5 }, inventory, nearbyPlayers: [], blockSurvey: { radius: 8, verticalRadius: 5, sampledBlocks: 10, solidBlocks: 8, blockEntityCount: 0, center: { x: 5, y: 64, z: 5 }, resources: [{ blockId: 'minecraft:oak_log', category: 'logs', count: 3, nearestDistance: 2 }, { blockId: 'minecraft:stone', category: 'stone', count: 20, nearestDistance: 1 }], artificial: [], other: [], classification: 'natural_terrain_likely', protectedLikely: false, reasons: [] } }
}

test('自主发展先把已有原木合成木板，再按扫描结果采集短缺资源', () => {
  assert.deepEqual(planAutonomousDevelopment(config, surveyed([{ name: '原木', itemId: 'minecraft:oak_log', count: 1 }])), { type: 'craft_item', itemId: 'minecraft:oak_planks', count: 4 })
  assert.deepEqual(planAutonomousDevelopment(config, surveyed()), { type: 'gather_resource', resource: 'wood', count: 2 })
})

test('自主发展不会在附近已有工作台时重复制作工作台', () => {
  const world = surveyed([
    { name: '橡木木板', itemId: 'minecraft:oak_planks', count: 4 },
    { name: '木棍', itemId: 'minecraft:stick', count: 4 }
  ])
  world.blockSurvey!.artificial.push({ blockId: 'minecraft:crafting_table', category: 'other', count: 1, nearestDistance: 2 })
  assert.deepEqual(planAutonomousDevelopment(config, world), {
    type: 'craft_item', itemId: 'minecraft:wooden_pickaxe', count: 1
  })
})

test('自主发展会把背包工作台放进批准区', () => {
  assert.deepEqual(planAutonomousDevelopment(config, surveyed([
    { name: '工作台', itemId: 'minecraft:crafting_table', placeableBlockId: 'minecraft:crafting_table', count: 1 },
    { name: '橡木木板', itemId: 'minecraft:oak_planks', count: 3 },
    { name: '木棍', itemId: 'minecraft:stick', count: 4 }
  ])), { type: 'place_block', itemId: 'minecraft:crafting_table', count: 1 })
})

test('批准区外不产生自主移动或破坏动作', () => {
  const world = surveyed(); world.position = { x: 100, y: 64, z: 100 }; world.blockSurvey!.center = world.position
  assert.deepEqual(planAutonomousDevelopment(config, world), { type: 'return_to_zone' })
})
