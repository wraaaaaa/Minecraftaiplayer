import { autonomyConfig, type BotConfig } from '../config/types.js'
import type { AgentAction } from '../policy/policy-engine.js'
import type { WorldState } from './world-state.js'

export interface CapabilityAssessment {
  status: 'ready' | 'needs_preparation' | 'unsupported' | 'forbidden' | 'blocked'
  reasons: string[]
  remediation?: string
}

const ARMOR_SLOTS = ['head', 'chest', 'legs', 'feet'] as const

function materialTier(itemId: string): number {
  if (itemId.includes('netherite_')) return 5
  if (itemId.includes('diamond_')) return 4
  if (itemId.includes('iron_')) return 3
  if (itemId.includes('golden_')) return 2
  if (itemId.includes('chainmail_')) return 2
  if (itemId.includes('copper_')) return 2
  if (itemId.includes('stone_')) return 1
  if (itemId.includes('leather_') || itemId.includes('wooden_')) return 1
  return 0
}

function isKnownSafeFood(item: { itemId?: string; name: string; safeFood?: boolean }): boolean {
  if (item.safeFood === true) return true
  const id = (item.itemId ?? item.name).toLowerCase()
  return /(?:^|:)(?:apple|golden_apple|enchanted_golden_apple|bread|cooked_(?:beef|porkchop|chicken|mutton|rabbit|cod|salmon)|carrot|golden_carrot|baked_potato|melon_slice|sweet_berries|glow_berries|beetroot|beetroot_soup|mushroom_stew|rabbit_stew|cookie|pumpkin_pie|dried_kelp|honey_bottle)$/u.test(id)
}

function isUsable(item: { durability?: number; maxDurability?: number }): boolean {
  if (!item.maxDurability || item.durability === undefined) return true
  return item.maxDurability - item.durability >= Math.max(5, Math.ceil(item.maxDurability * 0.2))
}

export function assessAction(config: BotConfig, action: AgentAction, world: WorldState, options: { requesterName?: string } = {}): CapabilityAssessment {
  if (!world.connected) return { status: 'blocked', reasons: ['Minecraft 客户端尚未进入世界'], remediation: '等待客户端成功进服后重试。' }
  const autonomy = autonomyConfig(config)
  switch (action.type) {
    case 'follow_player':
    case 'come_to_player':
      if (!world.nearbyPlayers.some(player => player.name.toLowerCase() === action.target.toLowerCase())
        && !(action.target.toLowerCase() === autonomy.ownerName.toLowerCase() && world.ownerWaypoint)) {
        return { status: 'blocked', reasons: [`附近找不到玩家 ${action.target}，且服务器定位栏没有提供其全图方位`], remediation: '请确认该玩家在线并启用服务器玩家定位栏。' }
      }
      return { status: 'ready', reasons: [] }
    case 'look_at_player':
    case 'attack_player':
      if (!world.nearbyPlayers.some(player => player.name.toLowerCase() === action.target.toLowerCase())) return { status: 'blocked', reasons: [`附近 32 格内找不到玩家 ${action.target}`], remediation: '请让目标玩家靠近 Bot。' }
      return { status: 'ready', reasons: [] }
    case 'eat_best_food': {
      const food = world.inventory.filter(isKnownSafeFood)
      return food.length > 0 ? { status: 'ready', reasons: [] } : { status: 'blocked', reasons: ['背包中没有客户端可识别的安全食物'], remediation: '先给 Bot 食物，或让它在经 Fabric 验证的安全环境获取食物。' }
    }
    case 'wander':
      return { status: 'ready', reasons: ['Fabric 会根据已加载地形、碰撞、危险源和可撤退路径选择短距离目标'] }
    case 'return_to_zone':
      return { status: 'unsupported', reasons: ['人工开发区功能已经取消'], remediation: '改用 explore_frontier、come_to_player 或 seek_shelter。' }
    case 'explore_frontier':
      return autonomy.allowVerifiedWilderness
        ? { status: 'ready', reasons: ['Fabric 会使用已加载地形、碰撞和荒野结构扫描选择探索前沿'] }
        : { status: 'blocked', reasons: ['未启用 Fabric 动态环境验证'], remediation: '启用 allowVerifiedWilderness。' }
    case 'attack_hostile':
      return (world.nearbyHostiles?.length ?? 0) > 0 ? { status: 'ready', reasons: [] } : { status: 'blocked', reasons: ['附近没有可确认的敌对生物'], remediation: '靠近明确的敌对生物后再试；Bot 不会把玩家或中立生物当作目标。' }
    case 'gather_resource':
      if (!autonomy.autoGather) return { status: 'forbidden', reasons: ['配置已关闭自主采集'], remediation: '在 WebUI 的自主能力设置中启用自主采集。' }
      if (!autonomy.allowVerifiedWilderness) return { status: 'blocked', reasons: ['未启用 Fabric 动态环境验证'], remediation: '启用 allowVerifiedWilderness。' }
      return { status: 'ready', reasons: ['实际方块仍将由 Fabric 安全层逐块验证'] }
    case 'craft_item':
      return autonomy.autoCraft ? { status: 'ready', reasons: [] } : { status: 'forbidden', reasons: ['配置已关闭自主合成'], remediation: '在 WebUI 的自主能力设置中启用自主合成。' }
    case 'place_block':
      if (!autonomy.allowVerifiedWilderness) return { status: 'blocked', reasons: ['未启用 Fabric 动态环境验证'], remediation: '启用 allowVerifiedWilderness。' }
      if (!world.inventory.some(item => item.placeableBlockId && (!action.itemId || item.itemId === action.itemId))) return { status: 'blocked', reasons: [action.itemId ? `背包里没有可安全放置的 ${action.itemId}` : '背包里没有可识别的方块物品'], remediation: '先准备泥土、圆石、石头或木板等普通建筑方块。' }
      return { status: 'ready', reasons: ['实际放置位置仍由 Fabric 根据环境和服务器回传逐格验证'] }
    case 'hunt_entity':
      if (!autonomy.autoHunt) return { status: 'forbidden', reasons: ['配置已关闭自主狩猎'] }
      return { status: 'ready', reasons: ['Fabric 会在游戏内再次排除幼体、驯化、拴绳、命名和靠近玩家设施的目标'] }
    case 'smelt_item':
      return autonomy.autoSmelt ? { status: 'ready', reasons: [] } : { status: 'forbidden', reasons: ['配置已关闭自主冶炼/烹饪'] }
    case 'trade_villager':
      return autonomy.autoTrade ? { status: 'ready', reasons: [] } : { status: 'forbidden', reasons: ['配置已关闭村民交易'] }
    case 'enchant_item':
      return autonomy.autoEnchant ? { status: 'ready', reasons: [] } : { status: 'forbidden', reasons: ['配置已关闭自主附魔'] }
    case 'sleep_in_bed':
      return autonomy.autoSleep ? { status: 'ready', reasons: [] } : { status: 'forbidden', reasons: ['配置已关闭自主睡觉'] }
    case 'excavate_tunnel':
      if (!autonomy.autoMine) return { status: 'forbidden', reasons: ['配置已关闭自主下矿'] }
      if (!autonomy.allowVerifiedWilderness) return { status: 'blocked', reasons: ['未启用可验证环境开矿'] }
      return { status: 'ready', reasons: ['Fabric 会逐格检查天然方块、危险流体、方块实体、玩家距离和撤退路径'] }
    case 'travel_to_dimension':
      return autonomy.autoDimensionTravel ? { status: 'ready', reasons: [] } : { status: 'forbidden', reasons: ['配置已关闭自主维度旅行'] }
    case 'build_nether_portal':
      if (!autonomy.autoDimensionTravel) return { status: 'forbidden', reasons: ['配置已关闭自主维度旅行'] }
      if (!autonomy.allowVerifiedWilderness) return { status: 'blocked', reasons: ['没有启用逐目标安全建造验证'] }
      if (world.inventory.reduce((sum, item) => sum + (item.itemId === 'minecraft:obsidian' ? item.count : 0), 0) < 14) return { status: 'blocked', reasons: ['建造完整安全门框需要 14 个黑曜石'] }
      if (!world.inventory.some(item => item.itemId === 'minecraft:flint_and_steel')) return { status: 'blocked', reasons: ['缺少打火石'] }
      return { status: 'ready', reasons: ['Fabric 会在经验证的空旷荒野逐块放置并确认门框'] }
    case 'drop_item':
      if (!world.nearbyPlayers.some(player => player.name.toLowerCase() === action.target.toLowerCase())) return { status: 'blocked', reasons: [`附近 32 格内找不到接收玩家 ${action.target}`], remediation: '请让接收玩家靠近 Bot。' }
      if (!world.inventory.some(item => item.count > 0 && (!action.itemId || item.itemId === action.itemId))) return { status: 'blocked', reasons: [action.itemId ? `背包里没有 ${action.itemId}` : '背包中没有可丢出的物品'], remediation: '先把对应物品放进 Bot 背包。' }
      return { status: 'ready', reasons: ['Fabric 会接近指定玩家并验证自身背包数量实际减少'] }
    case 'build_shelter':
      if (!autonomy.autoBuildShelter) return { status: 'forbidden', reasons: ['配置已关闭自主建造庇护所'], remediation: '在 WebUI 中启用自主建造；实际施工点仍会由 Fabric 验证并避开玩家建筑。' }
      if (!autonomy.allowVerifiedWilderness) return { status: 'blocked', reasons: ['未启用动态环境验证'], remediation: '启用 allowVerifiedWilderness。' }
      return { status: 'ready', reasons: ['Fabric 必须逐块确认目标是安全天然地形或 Bot 自有方块，并检查玩家结构和撤退路线'] }
    case 'prepare_for':
    case 'equip_best':
      if (action.purpose !== 'end_combat') return { status: 'ready', reasons: [] }
      return assessEndCombat(world)
    default:
      return { status: 'ready', reasons: [] }
  }
}

function assessEndCombat(world: WorldState): CapabilityAssessment {
  const equipment = world.equipment ?? {}
  const missing: string[] = []
  for (const slot of ARMOR_SLOTS) {
    const item = equipment[slot]
    if (!item) { missing.push(`${slot} 槽没有护甲`); continue }
    const equivalentScore = materialTier(item.itemId) * 2 + (item.enchanted ? 1 : 0)
    if (equivalentScore < 5) missing.push(`${slot} 槽的 ${item.itemId} 低于“附魔黄金护甲”等效门槛`)
    if (!isUsable(item)) missing.push(`${slot} 槽护甲耐久低于安全余量`)
  }
  const weapon = [equipment.mainHand, ...world.inventory]
    .filter((item): item is NonNullable<typeof item> => Boolean(item && /_(?:sword|axe)$/u.test(item.itemId ?? '')))
    .filter(isUsable)
    .sort((left, right) => (materialTier(right.itemId ?? '') * 2 + (right.enchanted ? 1 : 0)) - (materialTier(left.itemId ?? '') * 2 + (left.enchanted ? 1 : 0)))[0]
  if (!weapon || materialTier(weapon.itemId ?? '') * 2 + (weapon.enchanted ? 1 : 0) < 5) missing.push('没有达到附魔黄金剑等效门槛的可用武器')
  const foodCount = world.inventory.filter(isKnownSafeFood).reduce((sum, item) => sum + item.count, 0)
  if (foodCount < 16) missing.push(`安全食物只有 ${foodCount} 个，建议至少 16 个`)
  if (missing.length === 0) return { status: 'ready', reasons: ['装备达到附魔黄金套装等效门槛'] }
  return { status: 'needs_preparation', reasons: missing, remediation: 'Bot 会先选择现有最佳装备；无法自行补齐的材料、附魔或食物需要玩家提供或批准采集。' }
}

export function refusalFor(assessment: CapabilityAssessment): string {
  const details = assessment.reasons.length > 0 ? assessment.reasons.join('；') : '当前条件不满足'
  return `这项指令现在无法安全完成。原因：${details}。${assessment.remediation ?? '条件改变后可以再让我尝试。'}`.slice(0, 240)
}
