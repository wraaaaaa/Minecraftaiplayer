import { autonomyConfig, type BotConfig } from '../config/types.js'
import type { AgentAction } from '../policy/policy-engine.js'
import type { WorldState } from './world-state.js'

function count(world: WorldState, predicate: (id: string) => boolean): number {
  return world.inventory.reduce((sum, item) => sum + (predicate((item.itemId ?? '').toLowerCase()) ? item.count : 0), 0)
}

function insideApprovedZone(config: BotConfig, world: WorldState): boolean {
  const zone = autonomyConfig(config).developmentZone
  const point = world.blockSurvey?.center ?? world.position
  if (!zone?.enabled || !point || (world.dimension && zone.dimension !== world.dimension)) return false
  return point.x >= zone.minX && point.x <= zone.maxX
    && point.y >= zone.minY && point.y <= zone.maxY
    && point.z >= zone.minZ && point.z <= zone.maxZ
}

function hasSurveyed(world: WorldState, category: string): boolean {
  return world.blockSurvey?.resources.some(entry => entry.category === category && entry.count > 0) ?? false
}

function hasNearbyBlock(world: WorldState, blockId: string): boolean {
  return [...(world.blockSurvey?.resources ?? []), ...(world.blockSurvey?.artificial ?? []), ...(world.blockSurvey?.other ?? [])]
    .some(entry => entry.blockId === blockId && entry.count > 0)
}

/** Chooses one conservative self-development step from verified inventory and nearby block data. */
export function planAutonomousDevelopment(config: BotConfig, world: WorldState): AgentAction | undefined {
  const autonomy = autonomyConfig(config)
  if (!autonomy.enabled || !autonomy.developmentZone?.enabled || !world.position) return undefined
  if (world.dimension && autonomy.developmentZone.dimension !== world.dimension) return undefined
  if (!insideApprovedZone(config, world)) return { type: 'return_to_zone' }
  if (!world.blockSurvey) return undefined

  const logs = count(world, id => id.endsWith('_log') || id.endsWith('_wood'))
  const planks = count(world, id => id.endsWith('_planks'))
  const stone = count(world, id => id === 'minecraft:stone' || id === 'minecraft:cobblestone' || id === 'minecraft:cobbled_deepslate')
  const sticks = count(world, id => id === 'minecraft:stick')

  if (autonomy.autoCraft && logs > 0 && planks < 4) {
    const logId = world.inventory.find(item => /_(?:log|wood)$/u.test(item.itemId ?? ''))?.itemId
    const species = logId?.match(/^minecraft:([a-z0-9_]+?)_(?:log|wood)$/u)?.[1]
    if (species) return { type: 'craft_item', itemId: `minecraft:${species}_planks`, count: 4 }
  }
  if (autonomy.autoCraft && planks >= 4
    && count(world, id => id === 'minecraft:crafting_table') === 0
    && !hasNearbyBlock(world, 'minecraft:crafting_table')) {
    return { type: 'craft_item', itemId: 'minecraft:crafting_table', count: 1 }
  }
  if (autonomy.autoCraft && planks >= 2 && sticks < 4) return { type: 'craft_item', itemId: 'minecraft:stick', count: 4 }
  if (count(world, id => id === 'minecraft:crafting_table') > 0 && !hasNearbyBlock(world, 'minecraft:crafting_table')) {
    return { type: 'place_block', itemId: 'minecraft:crafting_table', count: 1 }
  }
  if (autonomy.autoCraft && hasNearbyBlock(world, 'minecraft:crafting_table') && planks >= 3 && sticks >= 2
    && count(world, id => id.endsWith('_pickaxe')) === 0) {
    return { type: 'craft_item', itemId: 'minecraft:wooden_pickaxe', count: 1 }
  }
  if (autonomy.autoGather && logs < 8 && hasSurveyed(world, 'logs')) return { type: 'gather_resource', resource: 'wood', count: 2 }
  if (autonomy.autoGather && stone < 16 && hasSurveyed(world, 'stone')) return { type: 'gather_resource', resource: 'stone', count: 4 }

  return { type: 'wander', radius: 4 }
}
