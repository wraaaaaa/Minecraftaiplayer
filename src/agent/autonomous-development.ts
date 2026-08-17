import { autonomyConfig, type BotConfig } from '../config/types.js'
import type { ProgressionDocument, ProgressionStage } from '../progression/progression-store.js'
import type { AgentAction } from '../policy/policy-engine.js'
import type { WorldState } from './world-state.js'

export interface DevelopmentPlan {
  stage: ProgressionStage
  reason: string
  action: AgentAction
}

function count(world: WorldState, predicate: (id: string) => boolean): number {
  return world.inventory.reduce((sum, item) => sum + (predicate((item.itemId ?? '').toLowerCase()) ? item.count : 0), 0)
}

function firstItem(world: WorldState, predicate: (id: string) => boolean): string | undefined {
  return world.inventory.find(item => item.itemId && predicate(item.itemId.toLowerCase()))?.itemId
}

function hasSurveyed(world: WorldState, category: string): boolean {
  return world.blockSurvey?.resources.some(entry => entry.category === category && entry.count > 0) ?? false
}

function hasNearbyOwnedBlock(world: WorldState, predicate: (id: string) => boolean): boolean {
  return world.blockSurvey?.owned?.some(entry => predicate(entry.blockId) && entry.count > 0) ?? false
}

function plan(stage: ProgressionStage, reason: string, action: AgentAction): DevelopmentPlan {
  return { stage, reason, action }
}

function resourcePlan(
  world: WorldState,
  progression: ProgressionDocument | undefined,
  stage: ProgressionStage,
  resource: string,
  category: string,
  count: number,
  targetY: number
): DevelopmentPlan {
  const gatherKey = `gather_resource:${resource}`
  // 当请求的矿石已经可见时，之前失败的石头路线绝不能迫使后续的
  // 煤/铁/钻石搜索进入盲目挖掘。
  const failures = progression?.failures[gatherKey]?.count ?? 0
  if (hasSurveyed(world, category) && failures < 3) {
    return plan(stage, `附近扫描发现 ${category}，直接采集并验证掉落物`, { type: 'gather_resource', resource, count })
  }
  return plan(stage, `附近没有可见 ${category} 或直接采集连续失败，按目标高度开安全双格矿道`, {
    type: 'excavate_tunnel', resource, targetY, length: Math.max(8, Math.min(32, count * 4))
  })
}

function missingTool(world: WorldState, tier: 'stone' | 'iron' | 'diamond'): string | undefined {
  const tools = ['pickaxe', 'axe', 'sword', 'shovel', 'hoe']
  return tools.map(tool => `minecraft:${tier}_${tool}`).find(itemId => count(world, id => id === itemId) === 0)
}

function missingArmor(world: WorldState, tier: 'iron' | 'diamond'): string | undefined {
  const equipped = Object.values(world.equipment ?? {}).flatMap(item => item?.itemId ? [item.itemId] : [])
  const owned = new Set([...world.inventory.flatMap(item => item.itemId ? [item.itemId] : []), ...equipped])
  return ['helmet', 'chestplate', 'leggings', 'boots']
    .map(piece => `minecraft:${tier}_${piece}`)
    .find(itemId => !owned.has(itemId))
}

function armorUnits(itemId: string): number {
  if (itemId.endsWith('_helmet')) return 5
  if (itemId.endsWith('_chestplate')) return 8
  if (itemId.endsWith('_leggings')) return 7
  return 4
}

function equipmentTier(itemId: string): number {
  if (itemId.includes('netherite_')) return 5
  if (itemId.includes('diamond_')) return 4
  if (itemId.includes('iron_')) return 3
  if (itemId.includes('golden_') || itemId.includes('chainmail_')) return 2
  if (itemId.includes('leather_')) return 1
  return 0
}

function needsBestEquipment(world: WorldState): boolean {
  const equipped = Object.values(world.equipment ?? {}).flatMap(item => item?.itemId ? [item.itemId] : [])
  return ['helmet', 'chestplate', 'leggings', 'boots'].some(piece => {
    const bestInventory = world.inventory
      .filter(item => item.itemId?.endsWith(`_${piece}`))
      .reduce((best, item) => Math.max(best, equipmentTier(item.itemId ?? '')), 0)
    const current = equipped
      .filter(itemId => itemId.endsWith(`_${piece}`))
      .reduce((best, itemId) => Math.max(best, equipmentTier(itemId)), 0)
    return bestInventory > current
  })
}

function requiredUnits(itemId: string): number {
  if (itemId.endsWith('_shovel')) return 1
  if (itemId.endsWith('_sword') || itemId.endsWith('_hoe')) return 2
  return 3
}

function safeFoodCount(world: WorldState): number {
  return world.inventory.reduce((sum, item) => {
    const id = (item.itemId ?? '').toLowerCase()
    const knownVanilla = /(?:apple|bread|cooked_[a-z0-9_]+|baked_potato|carrot|melon_slice|sweet_berries|glow_berries|beetroot|beetroot_soup|mushroom_stew|rabbit_stew|cookie|pumpkin_pie|dried_kelp|honey_bottle)$/u.test(id)
    return sum + (item.safeFood === true || knownVanilla ? item.count : 0)
  }, 0)
}

function rawFood(world: WorldState): string | undefined {
  return firstItem(world, id => /:(?:beef|porkchop|chicken|mutton|rabbit|cod|salmon|potato)$/u.test(id))
}

function bedWoolStack(world: WorldState): { itemId: string; count: number } | undefined {
  return world.inventory
    .filter((item): item is typeof item & { itemId: string } => Boolean(item.itemId?.endsWith('_wool')))
    .sort((left, right) => right.count - left.count)[0]
}

/**
 * 选择朝向持久自给自足的一步确定、可观察的行动。
 * AI 会自行保持进食、庇护和装备，但它绝不会把
 * 前往末地当作自主目标；当玩家要求时，所有工具仍然可用。
 */
export function planAutonomousDevelopment(
  config: BotConfig,
  world: WorldState,
  progression?: ProgressionDocument
): DevelopmentPlan | undefined {
  const autonomy = autonomyConfig(config)
  if (!autonomy.enabled || !world.connected || !world.position) return undefined

  const food = world.food ?? 20
  const readyFood = safeFoodCount(world)
  const raw = rawFood(world)
  const logs = count(world, id => id.endsWith('_log') || id.endsWith('_wood'))
  const planks = count(world, id => id.endsWith('_planks'))
  const sticks = count(world, id => id === 'minecraft:stick')
  const cobble = count(world, id => id === 'minecraft:cobblestone' || id === 'minecraft:cobbled_deepslate' || id === 'minecraft:blackstone')
  const coal = count(world, id => id === 'minecraft:coal' || id === 'minecraft:charcoal')
  const rawIron = count(world, id => id === 'minecraft:raw_iron')
  const iron = count(world, id => id === 'minecraft:iron_ingot')
  const diamonds = count(world, id => id === 'minecraft:diamond')
  const wool = count(world, id => id.endsWith('_wool'))
  const hasTable = count(world, id => id === 'minecraft:crafting_table') > 0
    || hasNearbyOwnedBlock(world, id => id === 'minecraft:crafting_table')
  const hasFurnace = count(world, id => id === 'minecraft:furnace') > 0
    || hasNearbyOwnedBlock(world, id => id === 'minecraft:furnace')
  const hasBed = count(world, id => id.endsWith('_bed')) > 0
    || hasNearbyOwnedBlock(world, id => id.endsWith('_bed'))
  const fuel = coal + logs + planks
  const lastFailure = progression?.lastResult?.ok === false ? progression.lastResult.detail : ''

  // 生存始终优先于发展。饥饿值低于 20 时按设计会触发行动。
  if (world.dimension === 'minecraft:the_end' && food < 20 && readyFood === 0 && autonomy.autoDimensionTravel) {
    return plan('survive', '末地没有可获取的普通食物，先经中央出口返回主世界补给', { type: 'travel_to_dimension', dimension: 'minecraft:overworld' })
  }
  if (food < 20 && readyFood > 0) return plan('survive', `饥饿值 ${food}/20，立即进食`, { type: 'eat_best_food' })

  // 空闲时若漂在非主世界维度（下界/末地），先返回主世界再回家/安全待机。
  if (world.dimension === 'minecraft:the_nether' || world.dimension === 'minecraft:the_end') {
    const dimLabel = world.dimension === 'minecraft:the_nether' ? '下界' : '末地'
    return plan('survive', `当前在${dimLabel}，空闲先返回主世界`, { type: 'travel_to_dimension', dimension: 'minecraft:overworld' })
  }

  // 陪伴模式默认不做自主自给自足：破坏/采集/狩猎/建造/合成都留给玩家明确指令，
  // 这里只保留进食等纯生存反射（水下换气、逃生、受击自卫由 Java 本地层负责）。
  const selfSufficient = autonomy.autoGather || autonomy.autoMine || autonomy.autoHunt
    || autonomy.autoCraft || autonomy.autoBuildShelter || autonomy.autoSmelt
    || autonomy.autoTrade || autonomy.autoEnchant
  if (!selfSufficient) return undefined
  if (food < 20 && raw && hasNearbyOwnedBlock(world, id => id === 'minecraft:furnace') && fuel > 0 && autonomy.autoSmelt) {
    return plan('survive', '安全熟食不足，先把现有生食烹饪成熟食', { type: 'smelt_item', inputItemId: raw, count: Math.min(8, count(world, id => id === raw)) })
  }
  if (food < 20 && raw && !hasNearbyOwnedBlock(world, id => id === 'minecraft:furnace')) {
    if (count(world, id => id === 'minecraft:furnace') > 0) {
      return plan('survive', '放置自有熔炉以处理当前生食', { type: 'place_block', itemId: 'minecraft:furnace', count: 1 })
    }
    if (!hasNearbyOwnedBlock(world, id => id === 'minecraft:crafting_table')) {
      if (count(world, id => id === 'minecraft:crafting_table') > 0) {
        return plan('survive', '放置自有工作台以制作食物烹饪设施', { type: 'place_block', itemId: 'minecraft:crafting_table', count: 1 })
      }
      if (planks >= 4) return plan('survive', '制作食物烹饪设施所需工作台', { type: 'craft_item', itemId: 'minecraft:crafting_table', count: 1 })
    }
    if (cobble >= 8 && hasNearbyOwnedBlock(world, id => id === 'minecraft:crafting_table')) {
      return plan('survive', '制作食物烹饪所需熔炉', { type: 'craft_item', itemId: 'minecraft:furnace', count: 1 })
    }
    const emergencyStone = world.dimension === 'minecraft:the_nether' ? 'minecraft:blackstone' : 'stone'
    return plan('survive', '采集制作熔炉所缺的天然石材', { type: 'gather_resource', resource: emergencyStone, count: Math.max(1, 8 - cobble) })
  }
  if (food < 20 && raw && hasNearbyOwnedBlock(world, id => id === 'minecraft:furnace') && fuel === 0) {
    if (hasSurveyed(world, 'logs')) return plan('survive', '采集少量天然木材作为紧急烹饪燃料', { type: 'gather_resource', resource: 'wood', count: 2 })
    return plan('survive', '当前缺少烹饪燃料，先沿安全路线寻找天然木材', { type: 'explore_frontier', purpose: 'wood', radius: 48 })
  }
  if (food < 20 && readyFood === 0 && progression?.lastAction === 'hunt_entity'
    && /no_safe_(?:loaded_hunt_target|route_to_hunt_(?:target|drop))/iu.test(lastFailure)) {
    if (world.dimension === 'minecraft:overworld' && world.environment?.skyVisible === false && world.position.y < 96) {
      return plan('survive', '当前在地下且没有可狩猎食物，开掘安全上行阶梯返回地表', {
        type: 'excavate_tunnel', resource: 'stone', targetY: Math.min(96, Math.floor(world.position.y) + 16), length: 16
      })
    }
    return plan('survive', '当前加载范围没有食物生物，沿安全路线搜索新的食物区域', {
      type: 'explore_frontier', purpose: 'food', radius: 64
    })
  }
  if (food < 20 && autonomy.autoHunt) {
    return plan('survive', '食物储备不足，寻找远离玩家设施的成年食物生物', { type: 'hunt_entity', purpose: 'food', count: Math.max(2, 8 - readyFood) })
  }

  if (world.dimension === 'minecraft:the_end') {
    // 末地不是自主目标；如果 AI 已经在那里，它只会保持一个安全位置。
    return undefined
  }

  if (world.dimension === 'minecraft:the_nether') {
    if (readyFood < 8 && raw && !hasNearbyOwnedBlock(world, id => id === 'minecraft:furnace')) {
      if (count(world, id => id === 'minecraft:furnace') > 0) {
        return plan('survive', '在下界安全工作点放置自有熔炉用于烹饪食物', { type: 'place_block', itemId: 'minecraft:furnace', count: 1 })
      }
      if (cobble >= 8) {
        return plan('survive', '制作下界烹饪食物所需的熔炉', { type: 'craft_item', itemId: 'minecraft:furnace', count: 1 })
      }
      return plan('survive', '采集黑石用于制作下界食物熔炉', { type: 'gather_resource', resource: 'minecraft:blackstone', count: 8 - cobble })
    }
    if (readyFood < 8 && raw && hasNearbyOwnedBlock(world, id => id === 'minecraft:furnace') && fuel > 0 && autonomy.autoSmelt) {
      return plan('survive', '把下界狩猎获得的生食烹饪成熟食', {
        type: 'smelt_item', inputItemId: raw, count: Math.min(8 - readyFood, count(world, id => id === raw))
      })
    }
    if (readyFood < 8 && progression?.lastAction === 'hunt_entity' && /no_safe_(?:loaded_hunt_target|route_to_hunt_(?:target|drop))/iu.test(lastFailure)) {
      return plan('survive', '下界食物储备不足且当前没有可狩猎目标，继续沿安全路线搜索疣猪兽', {
        type: 'explore_frontier', purpose: 'food', radius: 64
      })
    }
    if (readyFood < 8 && autonomy.autoHunt) {
      return plan('survive', '下界行动前补充食物掉落物储备', { type: 'hunt_entity', purpose: 'food', count: 8 - readyFood })
    }
    // 下界的自给自足止步于食物；AI 不再为了前往末地而刷烈焰棒。
    return undefined
  }

  // 资源决策需要 Fabric 的方块/结构勘察。等待
  // 下一帧状态比从不完整的桥接快照猜测更安全。
  if (!world.blockSurvey) return undefined

  if (progression?.lastAction === 'hunt_entity' && /no_safe_(?:loaded_hunt_target|route_to_hunt_(?:target|drop))/iu.test(lastFailure)
    && world.dimension === 'minecraft:overworld' && world.environment?.skyVisible === false && world.position.y < 96) {
    return plan(progression?.stage ?? 'survive', '狩猎目标不在当前地下加载范围，开掘安全上行阶梯返回地表继续寻找', {
      type: 'excavate_tunnel', resource: 'stone', targetY: Math.min(96, Math.floor(world.position.y) + 16), length: 16
    })
  }
  if (/(?:wilderness verification failed|player_building_blocks_nearby|block_entities_nearby|protected_structure)/iu.test(lastFailure)) {
    return plan(progression?.stage ?? 'survive', '当前工作点靠近受保护结构，先规划路线离开再继续采集或制作', {
      type: 'explore_frontier', purpose: 'resource', radius: 64
    })
  }
  if (/(?:no_safe_(?:loaded_hunt_target|route_to_hunt_(?:target|drop))|no matching loaded block|no collision-safe route|unable to reach|no safe reachable replaceable target|unsafe_or_artificial_tunnel_block)/iu.test(lastFailure)) {
    const purpose = progression?.lastAction === 'hunt_entity' ? 'food' : 'resource'
    return plan(progression?.stage ?? 'survive', '上一步目标不在已加载或可达范围，改为沿安全前沿寻找新目标', {
      type: 'explore_frontier', purpose, radius: 64
    })
  }

  const logId = firstItem(world, id => id.endsWith('_log') || id.endsWith('_wood'))
  const species = logId?.match(/^minecraft:([a-z0-9_]+?)_(?:log|wood)$/u)?.[1] ?? 'oak'
  if (autonomy.autoCraft && logs > 0 && planks < 16) return plan('wood_age', '把原木加工成基础木板', { type: 'craft_item', itemId: `minecraft:${species}_planks`, count: 4 })
  if (autonomy.autoCraft && !hasTable && planks >= 4) return plan('wood_age', '制作三乘三合成所需工作台', { type: 'craft_item', itemId: 'minecraft:crafting_table', count: 1 })
  if (count(world, id => id === 'minecraft:crafting_table') > 0 && !hasNearbyOwnedBlock(world, id => id === 'minecraft:crafting_table')) {
    return plan('wood_age', '在经 Fabric 验证的荒野位置放置自己的工作台', { type: 'place_block', itemId: 'minecraft:crafting_table', count: 1 })
  }
  if (autonomy.autoCraft && sticks < 4 && planks >= 2) return plan('wood_age', '储备基础工具所需木棍', { type: 'craft_item', itemId: 'minecraft:stick', count: 4 })
  if (count(world, id => id === 'minecraft:wooden_pickaxe') === 0 && !world.inventory.some(item => /:(?:stone|iron|diamond|netherite)_pickaxe$/u.test(item.itemId ?? ''))) {
    if (hasTable && planks >= 3 && sticks >= 2) return plan('wood_age', '制作第一把木镐以采集圆石', { type: 'craft_item', itemId: 'minecraft:wooden_pickaxe', count: 1 })
  }
  if (logs < 8 && autonomy.autoGather) {
    if (hasSurveyed(world, 'logs')) return plan('wood_age', '获取工作台、木棍和后续燃料所需原木', { type: 'gather_resource', resource: 'wood', count: 2 })
    return plan('wood_age', '当前加载范围没有树木，按有记录的探索前沿寻找树林', { type: 'explore_frontier', purpose: 'wood', radius: 48 })
  }

  if (cobble < 20 && autonomy.autoGather) return resourcePlan(world, progression, 'stone_age', 'stone', 'stone', 8, 48)
  if (!hasFurnace && cobble >= 8) return plan('stone_age', '制作烹饪食物和冶炼矿物所需熔炉', { type: 'craft_item', itemId: 'minecraft:furnace', count: 1 })
  if (count(world, id => id === 'minecraft:furnace') > 0 && !hasNearbyOwnedBlock(world, id => id === 'minecraft:furnace')) {
    return plan('stone_age', '在自己的荒野工作点放置熔炉', { type: 'place_block', itemId: 'minecraft:furnace', count: 1 })
  }
  if (readyFood < 8 && raw && hasNearbyOwnedBlock(world, id => id === 'minecraft:furnace') && fuel > 0 && autonomy.autoSmelt) {
    return plan('survive', '为后续采矿和跨维度行动储备熟食', { type: 'smelt_item', inputItemId: raw, count: Math.min(8, count(world, id => id === raw)) })
  }
  if (readyFood < 8 && autonomy.autoHunt) {
    return plan('survive', '在饥饿前主动储备至少八份可食用物', { type: 'hunt_entity', purpose: 'food', count: Math.max(2, 8 - readyFood) })
  }
  const stoneTool = missingTool(world, 'stone')
  if (stoneTool && cobble >= requiredUnits(stoneTool) && sticks >= 2) return plan('stone_age', `补齐基础工具 ${stoneTool}`, { type: 'craft_item', itemId: stoneTool, count: 1 })
  if (coal < 16 && autonomy.autoMine) return resourcePlan(world, progression, 'stone_age', 'coal', 'coal_ore', 8, 48)

  if (!world.home && world.dimension === 'minecraft:overworld' && world.environment?.skyVisible === false && world.position.y < 64) {
    return plan('stone_age', '建造住所和寻找羊前先开掘有实体支撑的安全上行阶梯返回地表', {
      type: 'excavate_tunnel', resource: 'stone', targetY: 64, length: 16
    })
  }

  if (!world.home && autonomy.autoBuildShelter) {
    const shellBlocks = count(world, id => /:(?:dirt|coarse_dirt|stone|cobblestone|granite|diorite|andesite|deepslate|cobbled_deepslate|tuff|bricks|mud_bricks|[a-z0-9_]+_(?:log|wood|planks))$/u.test(id))
    if (shellBlocks < 23) return resourcePlan(world, progression, 'stone_age', 'stone', 'stone', Math.max(4, 23 - shellBlocks), 48)
    if (count(world, id => id.endsWith('_door')) === 0) {
      if (planks < 6) {
        if (hasSurveyed(world, 'logs')) return plan('stone_age', '准备安全住所的门和建筑材料', { type: 'gather_resource', resource: 'wood', count: 2 })
        return plan('stone_age', '寻找木材以制作安全住所的门', { type: 'explore_frontier', purpose: 'wood', radius: 48 })
      }
      return plan('stone_age', '制作可关闭的住所木门', { type: 'craft_item', itemId: `minecraft:${species}_door`, count: 1 })
    }
    if (count(world, id => id === 'minecraft:torch') === 0) {
      if (sticks === 0 && planks >= 2) return plan('stone_age', '制作住所照明所需木棍', { type: 'craft_item', itemId: 'minecraft:stick', count: 4 })
      return plan('stone_age', '制作住所照明，防止怪物在屋内生成', { type: 'craft_item', itemId: 'minecraft:torch', count: 4 })
    }
    return plan('stone_age', '在经验证的荒野建造带门和照明的安全住所并记录坐标', { type: 'build_shelter' })
  }

  const bedWool = bedWoolStack(world)
  if (!hasBed && (bedWool?.count ?? 0) < 3 && autonomy.autoHunt) {
    return plan('stone_age', '继续获取羊毛，直到同一种颜色实际达到三份后再制作床', {
      type: 'hunt_entity', purpose: 'wool', count: 3 - (bedWool?.count ?? 0)
    })
  }
  if (!hasBed && bedWool && bedWool.count >= 3 && planks >= 3) {
    const woolId = bedWool.itemId
    const color = woolId.match(/^minecraft:([a-z_]+)_wool$/u)?.[1] ?? 'white'
    return plan('stone_age', '制作床用于夜间休息和设置重生点', { type: 'craft_item', itemId: `minecraft:${color}_bed`, count: 1 })
  }
  if (count(world, id => id.endsWith('_bed')) > 0 && !hasNearbyOwnedBlock(world, id => id.endsWith('_bed'))) {
    const bed = firstItem(world, id => id.endsWith('_bed'))
    return plan('stone_age', '在自己的安全工作点放置床', { type: 'place_block', count: 1, ...(bed ? { itemId: bed } : {}) })
  }
  if (hasBed && world.environment?.isNight && autonomy.autoSleep) return plan('stone_age', '夜间在床上睡觉并设置重生点', { type: 'sleep_in_bed' })

  if (rawIron + iron < 24 && autonomy.autoMine) return resourcePlan(world, progression, 'iron_age', 'iron', 'iron_ore', 8, 16)
  if (rawIron > 0 && hasFurnace && fuel > 0 && autonomy.autoSmelt) return plan('iron_age', '冶炼粗铁用于全套铁工具和装备', { type: 'smelt_item', inputItemId: 'minecraft:raw_iron', outputItemId: 'minecraft:iron_ingot', count: Math.min(rawIron, 16) })
  const ironTool = missingTool(world, 'iron')
  if (ironTool && iron >= requiredUnits(ironTool)) return plan('iron_age', `补齐全套铁工具：${ironTool}`, { type: 'craft_item', itemId: ironTool, count: 1 })
  const ironArmor = missingArmor(world, 'iron')
  if (ironArmor && iron < armorUnits(ironArmor)) return resourcePlan(world, progression, 'iron_age', 'iron', 'iron_ore', 6, 16)
  if (ironArmor) return plan('iron_age', `制作可靠的下矿与跨维度防护：${ironArmor}`, { type: 'craft_item', itemId: ironArmor, count: 1 })
  if (needsBestEquipment(world) && !world.inventory.some(item => /minecraft:diamond_(?:helmet|chestplate|leggings|boots)/u.test(item.itemId ?? ''))) {
    return plan('iron_age', '穿戴当前背包中防护最高的完整护甲并切换合适工具', { type: 'equip_best', purpose: 'general' })
  }
  if (count(world, id => id === 'minecraft:shield') === 0 && iron >= 1 && planks >= 6) return plan('iron_age', '制作盾牌用于抵挡怪物远程和近战伤害', { type: 'craft_item', itemId: 'minecraft:shield', count: 1 })
  if (count(world, id => id === 'minecraft:bucket') === 0 && iron >= 3) return plan('iron_age', '制作水桶用于灭火、落地缓冲和处理岩浆', { type: 'craft_item', itemId: 'minecraft:bucket', count: 1 })

  if (autonomy.autoTrade && (world.nearbyCreatures?.some(entity => entity.typeId === 'minecraft:villager') ?? false)
    && !progression?.milestones['completed:trade_villager']
    && (progression?.failures.trade_villager?.count ?? 0) < 3) {
    return plan('iron_age', '附近有村民和绿宝石，执行一次可承担的有益交易', { type: 'trade_villager', count: 1 })
  }

  if (diamonds < 12 && autonomy.autoMine) return resourcePlan(world, progression, 'diamond_age', 'diamond', 'diamond_ore', 4, -53)
  const diamondTool = missingTool(world, 'diamond')
  if (diamondTool && diamonds >= requiredUnits(diamondTool)) return plan('diamond_age', `补齐全套钻石工具：${diamondTool}`, { type: 'craft_item', itemId: diamondTool, count: 1 })
  const diamondArmor = missingArmor(world, 'diamond')
  if (diamondArmor && diamonds < armorUnits(diamondArmor)) return resourcePlan(world, progression, 'diamond_age', 'diamond', 'diamond_ore', 6, -53)
  if (diamondArmor) return plan('diamond_age', `制作长期跨维度发育所需钻石护甲：${diamondArmor}`, { type: 'craft_item', itemId: diamondArmor, count: 1 })
  if (needsBestEquipment(world)) return plan('diamond_age', '换上完整钻石护甲并选择当前任务所需最佳装备', { type: 'equip_best', purpose: 'general' })

  const obsidian = count(world, id => id === 'minecraft:obsidian')
  if (obsidian < 14 && autonomy.autoMine) return resourcePlan(world, progression, 'enchanting', 'obsidian', 'obsidian', 4, -53)
  const books = count(world, id => id === 'minecraft:book')
  const leather = count(world, id => id === 'minecraft:leather')
  const sugarCane = count(world, id => id === 'minecraft:sugar_cane')
  const paper = count(world, id => id === 'minecraft:paper')
  if (books === 0 && leather === 0 && autonomy.autoHunt) return plan('enchanting', '获取制作书和附魔台所需皮革', { type: 'hunt_entity', purpose: 'leather', count: 1 })
  if (books === 0 && paper < 3 && sugarCane < 3) {
    if (hasSurveyed(world, 'sugar_cane')) return plan('enchanting', '采集制作纸张所需甘蔗', { type: 'gather_resource', resource: 'sugar_cane', count: 3 - sugarCane })
    return plan('enchanting', '沿水边按探索前沿寻找甘蔗', { type: 'explore_frontier', purpose: 'resource', radius: 64 })
  }
  if (books === 0 && paper < 3 && sugarCane >= 3) return plan('enchanting', '把甘蔗制成纸', { type: 'craft_item', itemId: 'minecraft:paper', count: 3 })
  if (books === 0 && paper >= 3 && leather >= 1) return plan('enchanting', '制作附魔台配方所需书', { type: 'craft_item', itemId: 'minecraft:book', count: 1 })
  if (count(world, id => id === 'minecraft:lapis_lazuli') < 8 && autonomy.autoMine) return resourcePlan(world, progression, 'enchanting', 'lapis', 'lapis_ore', 4, 0)
  if (books > 0 && diamonds < 2 && autonomy.autoMine) {
    return resourcePlan(world, progression, 'enchanting', 'diamond', 'diamond_ore', 2 - diamonds, -53)
  }
  if (books > 0 && diamonds >= 2 && obsidian >= 4 && count(world, id => id === 'minecraft:enchanting_table') === 0) {
    return plan('enchanting', '制作附魔台提升工具和战斗装备', { type: 'craft_item', itemId: 'minecraft:enchanting_table', count: 1 })
  }
  if (count(world, id => id === 'minecraft:enchanting_table') > 0 && !hasNearbyOwnedBlock(world, id => id === 'minecraft:enchanting_table')) {
    return plan('enchanting', '在自己的安全工作点放置附魔台', { type: 'place_block', itemId: 'minecraft:enchanting_table', count: 1 })
  }
  if (autonomy.autoEnchant && hasNearbyOwnedBlock(world, id => id === 'minecraft:enchanting_table') && (world.experienceLevel ?? 0) > 0
    && count(world, id => id === 'minecraft:lapis_lazuli') > 0
    && world.inventory.some(item => /minecraft:diamond_(?:pickaxe|sword|axe|shovel|hoe|helmet|chestplate|leggings|boots)/u.test(item.itemId ?? '') && !item.enchanted)) {
    return plan('enchanting', '使用现有经验和青金石逐件附魔钻石工具与护甲', { type: 'enchant_item', minLevel: 1 })
  }
  if (autonomy.autoEnchant && hasNearbyOwnedBlock(world, id => id === 'minecraft:enchanting_table')
    && (world.experienceLevel ?? 0) === 0 && count(world, id => id === 'minecraft:lapis_lazuli') > 0) {
    return resourcePlan(world, progression, 'enchanting', 'coal', 'coal_ore', 4, 32)
  }

  // 自给自足已完成：保持安全位置，让陪伴行为
  // （跟随、保护、聊天）接管。不再自主寻找下界传送门或要塞。
  return undefined
}
