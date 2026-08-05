import type { BehaviorRules } from '../config/types.js'

export type AgentAction =
  | { type: 'none' }
  | { type: 'stop' }
  | { type: 'follow_player'; target: string }
  | { type: 'come_to_player'; target: string }
  | { type: 'look_at_player'; target: string }
  | { type: 'wander'; radius: number }
  | { type: 'explore_frontier'; purpose: 'food' | 'wood' | 'village' | 'portal' | 'resource'; radius: number }
  | { type: 'return_to_zone' }
  | { type: 'attack_player'; target: string }
  | { type: 'eat_best_food' }
  | { type: 'equip_best'; purpose: 'general' | 'mining' | 'combat' | 'end_combat' }
  | { type: 'attack_hostile'; targetId?: string; protectPlayer?: string }
  | { type: 'hunt_entity'; purpose: 'food' | 'wool' | 'leather' | 'ender_pearl' | 'blaze_rod'; count: number }
  | { type: 'collect_own_drops'; itemId?: string; count: number; radius: number }
  | { type: 'gather_resource'; resource: string; count: number; authorizedPlayer?: string; verifiedWilderness?: boolean; targetBlock?: { x: number; y: number; z: number } }
  | { type: 'craft_item'; itemId: string; count: number; verifiedWilderness?: boolean }
  | { type: 'place_block'; itemId?: string; count: number; verifiedWilderness?: boolean }
  | { type: 'smelt_item'; inputItemId?: string; outputItemId?: string; count: number }
  | { type: 'trade_villager'; desiredItemId?: string; count: number }
  | { type: 'enchant_item'; itemId?: string; minLevel?: number }
  | { type: 'sleep_in_bed' }
  | { type: 'excavate_tunnel'; resource?: string; targetY: number; length: number; verifiedWilderness?: boolean }
  | { type: 'travel_to_dimension'; dimension: 'minecraft:overworld' | 'minecraft:the_nether' | 'minecraft:the_end' }
  | { type: 'build_nether_portal'; verifiedWilderness?: boolean }
  | { type: 'drop_item'; itemId?: string; count: number; target: string }
  | { type: 'use_item'; itemId?: string }
  | { type: 'seek_shelter' }
  | { type: 'build_shelter'; verifiedWilderness?: boolean }
  | { type: 'wait_safe' }
  | { type: 'prepare_for'; purpose: 'general' | 'mining' | 'combat' | 'end_combat' }
  | { type: 'break_block'; block: string; ownership: 'natural' | 'player' | 'unknown'; evidence?: 'fabric_verified_zone' | 'bot_placement_ledger' }
  | { type: 'open_container'; ownership: 'player' | 'unknown' }

export interface PolicyDecision {
  allowed: boolean
  reason: string
}

export class PolicyEngine {
  readonly #rules: BehaviorRules
  readonly #recentAttackers = new Map<string, number>()

  constructor(rules: BehaviorRules) { this.#rules = rules }

  noteAttack(attacker: string, at = Date.now()): void { this.#recentAttackers.set(attacker.toLowerCase(), at) }

  authorize(action: AgentAction, now = Date.now()): PolicyDecision {
    switch (action.type) {
      case 'attack_player': {
        if (!this.#rules.allowSelfDefense) return { allowed: false, reason: '行为规则禁止 PVP' }
        if (this.#rules.allowPlayerOrderedPvp) return { allowed: true, reason: '规则允许玩家指令 PVP' }
        const attackedAt = this.#recentAttackers.get(action.target.toLowerCase())
        if (!attackedAt || now - attackedAt > this.#rules.selfDefenseWindowMs) return { allowed: false, reason: '目标不在有效自卫窗口内' }
        return { allowed: true, reason: '目标是有效自卫窗口内的攻击者' }
      }
      case 'break_block':
        if (action.evidence !== 'fabric_verified_zone' && action.evidence !== 'bot_placement_ledger') return { allowed: false, reason: '方块归属没有通过 Fabric 可信区域或 Bot 放置账本验证' }
        if (action.ownership === 'player' && this.#rules.denyBreakingPlayerProperty) return { allowed: false, reason: '禁止破坏玩家财产' }
        if (action.ownership === 'unknown' && !this.#rules.allowDestructiveActionsWhenOwnershipUnknown) return { allowed: false, reason: '无法确认归属时禁止破坏' }
        return { allowed: true, reason: '允许处理已确认的自然方块' }
      case 'open_container':
        if (action.ownership === 'player' && this.#rules.denyOpeningPlayerContainers) return { allowed: false, reason: '禁止打开玩家容器' }
        if (action.ownership === 'unknown') return { allowed: false, reason: '无法确认归属时禁止打开容器' }
        return { allowed: true, reason: '允许' }
      case 'gather_resource':
      case 'excavate_tunnel':
      case 'build_shelter':
        if (!this.#rules.wildernessDevelopmentOnly) return { allowed: true, reason: '运行时仍需验证目标方块与区域' }
        return { allowed: true, reason: '仅在 Fabric 对目标天然性、附近结构、危险源和撤退路线逐项验证后允许' }
      case 'place_block':
        return { allowed: true, reason: '仅允许在 Fabric 动态验证的安全位置放置普通建筑方块' }
      case 'hunt_entity':
        return { allowed: true, reason: 'Fabric 会筛选未命名、未驯化并远离玩家设施的合法生存目标' }
      case 'smelt_item':
      case 'trade_villager':
      case 'enchant_item':
      case 'sleep_in_bed':
      case 'travel_to_dimension':
      case 'build_nether_portal':
        return { allowed: true, reason: '允许可验证的生存交互' }
      case 'drop_item':
        return { allowed: true, reason: '只允许把自身背包物品丢给明确指定且在场的玩家' }
      case 'collect_own_drops':
        if (this.#rules.denyTakingPlayerItems) return { allowed: true, reason: '只允许收集本任务产生并由 Fabric 跟踪的掉落物' }
        return { allowed: true, reason: '允许收集掉落物' }
      default:
        return { allowed: true, reason: '非破坏性动作' }
    }
  }
}
