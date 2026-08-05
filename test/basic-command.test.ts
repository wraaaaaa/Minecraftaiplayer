import assert from 'node:assert/strict'
import test from 'node:test'
import { inferBasicDecision } from '../src/agent/basic-command.js'
import type { WorldState } from '../src/agent/world-state.js'

const world: WorldState = {
  connected: true,
  inventory: [
    { name: '橡木原木', itemId: 'minecraft:oak_log', placeableBlockId: 'minecraft:oak_log', count: 2 },
    { name: '圆石', itemId: 'minecraft:cobblestone', placeableBlockId: 'minecraft:cobblestone', count: 8 }
  ],
  nearbyPlayers: [],
  blockSurvey: {
    radius: 8, verticalRadius: 5, sampledBlocks: 1, solidBlocks: 1, blockEntityCount: 0,
    center: { x: 0, y: 64, z: 0 },
    resources: [{ blockId: 'minecraft:oak_log', category: 'logs', count: 4, nearestDistance: 2 }],
    artificial: [], other: [], classification: 'natural_terrain_likely', protectedLikely: false, reasons: []
  }
}

test('本地基础命令把挖掘、放置和合成转换为确定性动作', () => {
  assert.deepEqual(inferBasicDecision('挖掘三个石头', world)?.action, { type: 'gather_resource', resource: 'stone', count: 3 })
  assert.deepEqual(inferBasicDecision('随便放一个方块', world)?.action, { type: 'place_block', count: 1 })
  assert.deepEqual(inferBasicDecision('合成四个木板', world)?.action, { type: 'craft_item', itemId: 'minecraft:oak_planks', count: 4 })
  assert.deepEqual(inferBasicDecision('合成一个木镐', world)?.action, { type: 'craft_item', itemId: 'minecraft:wooden_pickaxe', count: 1 })
})

test('工作台放置命令优先使用背包中的工作台', () => {
  const withTable = structuredClone(world)
  withTable.inventory.push({ name: '工作台', itemId: 'minecraft:crafting_table', placeableBlockId: 'minecraft:crafting_table', count: 1 })
  assert.deepEqual(inferBasicDecision('放置一个工作台', withTable)?.action, {
    type: 'place_block', itemId: 'minecraft:crafting_table', count: 1
  })
})

test('模糊采集命令按环境扫描和背包短缺选择资源', () => {
  assert.deepEqual(inferBasicDecision('去采集一些材料', world)?.action, { type: 'gather_resource', resource: 'wood', count: 1 })
})

test('复合制作命令生成按依赖排序的基础工具计划', () => {
  const decision = inferBasicDecision('去自己采集材料合成一个木镐', world, 'Alice')
  assert.deepEqual(decision?.actions, [
    { type: 'gather_resource', resource: 'wood', count: 1 },
    { type: 'craft_item', itemId: 'minecraft:oak_planks', count: 12 },
    { type: 'craft_item', itemId: 'minecraft:crafting_table', count: 1 },
    { type: 'craft_item', itemId: 'minecraft:stick', count: 4 },
    { type: 'place_block', itemId: 'minecraft:crafting_table', count: 1 },
    { type: 'craft_item', itemId: 'minecraft:wooden_pickaxe', count: 1 }
  ])
})

test('交付物品和玩家准星方块不依赖模型猜动作', () => {
  const observed = structuredClone(world)
  observed.inventory.push({ name: '烤马铃薯', itemId: 'minecraft:baked_potato', count: 4 })
  observed.nearbyPlayers.push({
    name: 'Alice', distance: 2,
    lookingAtBlock: { blockId: 'minecraft:stone', x: 2, y: 64, z: 1, distance: 3 }
  })
  assert.deepEqual(inferBasicDecision('给我两个烤土豆', observed, 'Alice')?.action, {
    type: 'drop_item', itemId: 'minecraft:baked_potato', count: 2, target: 'Alice'
  })
  assert.deepEqual(inferBasicDecision('帮我挖掉这个方块', observed, 'Alice')?.action, {
    type: 'gather_resource', resource: 'minecraft:stone', count: 1,
    targetBlock: { x: 2, y: 64, z: 1 }
  })
})

test('原木与石砖的放置和采集使用精确基础动作', () => {
  const supplied = structuredClone(world)
  supplied.inventory.push({ name: '石砖', itemId: 'minecraft:stone_bricks', placeableBlockId: 'minecraft:stone_bricks', count: 4 })
  assert.deepEqual(inferBasicDecision('放置一个原木', supplied)?.action, {
    type: 'place_block', itemId: 'minecraft:oak_log', count: 1
  })
  assert.deepEqual(inferBasicDecision('采集一块石砖', supplied)?.action, {
    type: 'gather_resource', resource: 'minecraft:stone_bricks', count: 1
  })
})

test('烹饪、狩猎、矿道、交易、附魔、睡觉和跨维度命令不依赖模型猜测', () => {
  const withFood = structuredClone(world)
  withFood.inventory = [{ name: '生牛肉', itemId: 'minecraft:beef', count: 4 }]
  assert.deepEqual(inferBasicDecision('烹饪牛肉', withFood, 'Alice')?.action, { type: 'smelt_item', inputItemId: 'minecraft:beef', outputItemId: 'minecraft:cooked_beef', count: 1 })
  assert.deepEqual(inferBasicDecision('去狩猎三份食物', withFood, 'Alice')?.action, { type: 'hunt_entity', purpose: 'food', count: 3 })
  assert.deepEqual(inferBasicDecision('挖一条12格矿道', withFood, 'Alice')?.action, { type: 'excavate_tunnel', targetY: -53, length: 12 })
  assert.deepEqual(inferBasicDecision('和村民交易', withFood, 'Alice')?.action, { type: 'trade_villager', count: 1 })
  assert.deepEqual(inferBasicDecision('给钻石剑附魔', withFood, 'Alice')?.action, { type: 'enchant_item', minLevel: 1 })
  assert.deepEqual(inferBasicDecision('睡觉设置重生点', withFood, 'Alice')?.action, { type: 'sleep_in_bed' })
  assert.deepEqual(inferBasicDecision('前往末地', withFood, 'Alice')?.action, { type: 'travel_to_dimension', dimension: 'minecraft:the_end' })
})

test('最高优先玩家来找我和紧跟指令直接使用全图可续航动作', () => {
  const observed = structuredClone(world)
  assert.deepEqual(inferBasicDecision('来找我', observed, 'wraaaaaa')?.action, { type: 'come_to_player', target: 'wraaaaaa' })
  assert.deepEqual(inferBasicDecision('紧跟我', observed, 'wraaaaaa')?.action, { type: 'follow_player', target: 'wraaaaaa' })
})
