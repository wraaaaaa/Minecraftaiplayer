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

function isKnownSafeFood(item: { itemId?: string; name: string }): boolean {
  const id = (item.itemId ?? item.name).toLowerCase()
  return /(?:^|:)(?:apple|golden_apple|enchanted_golden_apple|bread|cooked_(?:beef|porkchop|chicken|mutton|rabbit|cod|salmon)|carrot|golden_carrot|baked_potato|melon_slice|sweet_berries|glow_berries|beetroot|beetroot_soup|mushroom_stew|rabbit_stew|cookie|pumpkin_pie|dried_kelp|honey_bottle)$/u.test(id)
}

function isUsable(item: { durability?: number; maxDurability?: number }): boolean {
  if (!item.maxDurability || item.durability === undefined) return true
  return item.maxDurability - item.durability >= Math.max(5, Math.ceil(item.maxDurability * 0.2))
}

export function assessAction(config: BotConfig, action: AgentAction, world: WorldState): CapabilityAssessment {
  if (!world.connected) return { status: 'blocked', reasons: ['Minecraft 客户端尚未进入世界'], remediation: '等待客户端成功进服后重试。' }
  const autonomy = autonomyConfig(config)
  switch (action.type) {
    case 'follow_player':
    case 'come_to_player':
    case 'look_at_player':
    case 'attack_player':
      if (!world.nearbyPlayers.some(player => player.name.toLowerCase() === action.target.toLowerCase())) return { status: 'blocked', reasons: [`附近 32 格内找不到玩家 ${action.target}`], remediation: '请让目标玩家靠近 Bot，或提供更明确的目标。' }
      return { status: 'ready', reasons: [] }
    case 'eat_best_food': {
      const food = world.inventory.filter(isKnownSafeFood)
      return food.length > 0 ? { status: 'ready', reasons: [] } : { status: 'blocked', reasons: ['背包中没有客户端可识别的安全食物'], remediation: '先给 Bot 食物，或让它在批准的采集区获取食物。' }
    }
    case 'attack_hostile':
      return (world.nearbyHostiles?.length ?? 0) > 0 ? { status: 'ready', reasons: [] } : { status: 'blocked', reasons: ['附近没有可确认的敌对生物'], remediation: '靠近明确的敌对生物后再试；Bot 不会把玩家或中立生物当作目标。' }
    case 'gather_resource':
      if (!autonomy.autoGather) return { status: 'forbidden', reasons: ['配置已关闭自主采集'], remediation: '在 WebUI 的自主能力设置中启用自主采集。' }
      if (!autonomy.developmentZone?.enabled) return { status: 'blocked', reasons: ['尚未配置管理员批准的采集/开发区域'], remediation: '先在 WebUI 设置 developmentZone；Bot 不会凭方块外观猜测它是否属于玩家。' }
      if (world.nearbyPlayers.some(player => player.distance < autonomy.wildernessMinPlayerDistance)) return { status: 'blocked', reasons: [`开发区附近仍有玩家，未达到 ${autonomy.wildernessMinPlayerDistance} 格荒野距离`], remediation: '等待附近玩家离开，或由管理员重新划定真正远离玩家建筑的开发区。' }
      return { status: 'ready', reasons: ['实际方块仍将由 Fabric 安全层逐块验证'] }
    case 'craft_item':
      return autonomy.autoCraft ? { status: 'ready', reasons: [] } : { status: 'forbidden', reasons: ['配置已关闭自主合成'], remediation: '在 WebUI 的自主能力设置中启用自主合成。' }
    case 'build_shelter':
      if (!autonomy.autoBuildShelter) return { status: 'forbidden', reasons: ['配置已关闭自主建造庇护所'], remediation: '在 WebUI 中启用自主建造，并确认开发区远离玩家建筑。' }
      if (!autonomy.developmentZone?.enabled) return { status: 'blocked', reasons: ['尚未配置管理员批准的开发区域'], remediation: '先在 WebUI 设置 developmentZone，避免 Bot 在未知归属土地上建造。' }
      if (world.nearbyPlayers.some(player => player.distance < autonomy.wildernessMinPlayerDistance)) return { status: 'blocked', reasons: [`开发区附近仍有玩家，未达到 ${autonomy.wildernessMinPlayerDistance} 格荒野距离`], remediation: '等待附近玩家离开，或由管理员重新划定真正远离玩家建筑的开发区。' }
      return { status: 'ready', reasons: ['Fabric 必须逐块确认目标位于批准区域'] }
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
