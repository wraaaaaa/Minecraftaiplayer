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
  autonomy: { ...DEFAULT_AUTONOMY_CONFIG, enabled: true, autoGather: true, autoCraft: true, autoBuildShelter: true, autoHunt: true, autoMine: true, autoSmelt: true, autoTrade: true, autoEnchant: true, autoDimensionTravel: true, discardWornTools: true, developmentZone: { enabled: true, dimension: 'minecraft:overworld', minX: 0, minY: 60, minZ: 0, maxX: 10, maxY: 70, maxZ: 10 } }
} satisfies BotConfig

function surveyed(inventory: WorldState['inventory'] = []): WorldState {
  return { connected: true, dimension: 'minecraft:overworld', position: { x: 5, y: 64, z: 5 }, inventory, nearbyPlayers: [], blockSurvey: { radius: 8, verticalRadius: 5, sampledBlocks: 10, solidBlocks: 8, blockEntityCount: 0, center: { x: 5, y: 64, z: 5 }, resources: [{ blockId: 'minecraft:oak_log', category: 'logs', count: 3, nearestDistance: 2 }, { blockId: 'minecraft:stone', category: 'stone', count: 20, nearestDistance: 1 }], artificial: [], other: [], classification: 'natural_terrain_likely', protectedLikely: false, reasons: [] } }
}

test('自主发展先把已有原木合成木板，再按扫描结果采集短缺资源', () => {
  assert.deepEqual(planAutonomousDevelopment(config, surveyed([{ name: '原木', itemId: 'minecraft:oak_log', count: 1 }]))?.action, { type: 'craft_item', itemId: 'minecraft:oak_planks', count: 4 })
  assert.deepEqual(planAutonomousDevelopment(config, surveyed())?.action, { type: 'gather_resource', resource: 'wood', count: 2 })
})

test('自主发展不会把附近玩家工作台误认为自己的工作台', () => {
  const world = surveyed([
    { name: '橡木木板', itemId: 'minecraft:oak_planks', count: 4 },
    { name: '木棍', itemId: 'minecraft:stick', count: 4 }
  ])
  world.blockSurvey!.artificial.push({ blockId: 'minecraft:crafting_table', category: 'other', count: 1, nearestDistance: 2 })
  assert.deepEqual(planAutonomousDevelopment(config, world)?.action, {
    type: 'craft_item', itemId: 'minecraft:crafting_table', count: 1
  })
})

test('自有方块账本中的工作台可供后续制作使用', () => {
  const world = surveyed([
    { name: '橡木木板', itemId: 'minecraft:oak_planks', count: 4 },
    { name: '木棍', itemId: 'minecraft:stick', count: 4 }
  ])
  world.blockSurvey!.owned = [{ blockId: 'minecraft:crafting_table', category: 'other', count: 1, nearestDistance: 2 }]
  assert.deepEqual(planAutonomousDevelopment(config, world)?.action, {
    type: 'craft_item', itemId: 'minecraft:wooden_pickaxe', count: 1
  })
})

test('Fabric FOOD 组件标记的模组熟食计入自主储备', () => {
  const world = surveyed([
    { name: '橡木原木', itemId: 'minecraft:oak_log', count: 8 },
    { name: '橡木木板', itemId: 'minecraft:oak_planks', count: 16 },
    { name: '木棍', itemId: 'minecraft:stick', count: 4 },
    { name: '圆石', itemId: 'minecraft:cobblestone', count: 20 },
    { name: '木镐', itemId: 'minecraft:wooden_pickaxe', count: 1 },
    { name: '鸡汤', itemId: 'farmersdelight:chicken_soup', count: 8, foodNutrition: 10, safeFood: true }
  ])
  world.blockSurvey!.owned = [
    { blockId: 'minecraft:crafting_table', category: 'other', count: 1, nearestDistance: 2 },
    { blockId: 'minecraft:furnace', category: 'other', count: 1, nearestDistance: 2 }
  ]
  assert.deepEqual(planAutonomousDevelopment(config, world)?.action, {
    type: 'craft_item', itemId: 'minecraft:stone_pickaxe', count: 1
  })
})

test('自主发展会把背包工作台放进逐目标验证的荒野工作点', () => {
  assert.deepEqual(planAutonomousDevelopment(config, surveyed([
    { name: '工作台', itemId: 'minecraft:crafting_table', placeableBlockId: 'minecraft:crafting_table', count: 1 },
    { name: '橡木木板', itemId: 'minecraft:oak_planks', count: 3 },
    { name: '木棍', itemId: 'minecraft:stick', count: 4 }
  ]))?.action, { type: 'place_block', itemId: 'minecraft:crafting_table', count: 1 })
})

test('废弃的人工开发区坐标不再限制自主发展', () => {
  const world = surveyed(); world.position = { x: 100, y: 64, z: 100 }; world.blockSurvey!.center = world.position
  assert.deepEqual(planAutonomousDevelopment(config, world)?.action, { type: 'gather_resource', resource: 'wood', count: 2 })
})

test('动态荒野验证发现玩家结构后先离开，不会无限重试同一制作动作', () => {
  const world = surveyed([{ name: '木板', itemId: 'minecraft:oak_planks', count: 16 }])
  const planned = planAutonomousDevelopment(config, world, {
    schemaVersion: 1,
    stage: 'stone_age',
    updatedAt: new Date().toISOString(),
    milestones: {},
    failures: { craft_item: { count: 3, lastAt: new Date().toISOString(), detail: '3x3 crafting wilderness verification failed: player_building_blocks_nearby=5' } },
    lastAction: 'craft_item',
    lastReason: '补齐石制工具',
    lastResult: { ok: false, detail: '3x3 crafting wilderness verification failed: player_building_blocks_nearby=5', at: new Date().toISOString() }
  })
  assert.deepEqual(planned?.action, { type: 'explore_frontier', purpose: 'resource', radius: 64 })
})

test('基础石器和照明齐备后在验证荒野建造持久住所', () => {
  const inventory: WorldState['inventory'] = [
    { name: '原木', itemId: 'minecraft:oak_log', count: 8 },
    { name: '木板', itemId: 'minecraft:oak_planks', count: 24 },
    { name: '木棍', itemId: 'minecraft:stick', count: 8 },
    { name: '圆石', itemId: 'minecraft:cobblestone', count: 24 },
    { name: '煤炭', itemId: 'minecraft:coal', count: 16 },
    { name: '熟牛肉', itemId: 'minecraft:cooked_beef', count: 12 },
    { name: '木门', itemId: 'minecraft:oak_door', count: 3 },
    { name: '火把', itemId: 'minecraft:torch', count: 4 },
    ...['pickaxe', 'axe', 'sword', 'shovel', 'hoe'].map(tool => ({ name: tool, itemId: `minecraft:stone_${tool}`, count: 1 }))
  ]
  const world = surveyed(inventory)
  world.blockSurvey!.owned = [
    { blockId: 'minecraft:crafting_table', category: 'other', count: 1, nearestDistance: 2 },
    { blockId: 'minecraft:furnace', category: 'other', count: 1, nearestDistance: 2 }
  ]
  assert.deepEqual(planAutonomousDevelopment(config, world)?.action, { type: 'build_shelter' })
})