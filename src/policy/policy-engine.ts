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
  | { type: 'return_home' }
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
  | { type: 'accept_items'; itemId?: string; count: number; target: string; radius: number }
  | { type: 'use_item'; itemId?: string }
  | { type: 'seek_shelter' }
  | { type: 'build_shelter'; verifiedWilderness?: boolean }
  | { type: 'wait_safe' }
  | { type: 'prepare_for'; purpose: 'general' | 'mining' | 'combat' | 'end_combat' }
  | { type: 'break_block'; block: string; ownership: 'natural' | 'player' | 'unknown'; evidence?: 'fabric_verified_zone' | 'bot_placement_ledger' }
  | { type: 'open_container'; ownership: 'player' | 'unknown' }
  // Agent-v2 concrete affordances. Each call performs one bounded game operation and
  // returns a postcondition; workflows are chosen by the model, not by a planner script.
  | { type: 'navigate_to'; x: number; y: number; z: number; stopDistance: number; sprint: boolean }
  | { type: 'look_at'; x: number; y: number; z: number }
  | { type: 'select_hotbar'; slot: number }
  | { type: 'break_block_at'; x: number; y: number; z: number; expectedBlockId?: string; authorizedPlayer?: string }
  | { type: 'place_block_at'; x: number; y: number; z: number; itemId?: string }
  | { type: 'attack_entity'; entityId: string }
  | { type: 'interact_entity'; entityId: string }
  | { type: 'interact_block'; x: number; y: number; z: number; hand: 'main' | 'off' }
  | { type: 'step_on_block'; x: number; y: number; z: number }
  | { type: 'use_held_item'; hand: 'main' | 'off' }
  | { type: 'drop_inventory_item'; slot: number; count: number }
  | { type: 'discard_worn_tools'; remainingDurability: number }
  | { type: 'gesture'; gesture: 'acknowledge' | 'happy' | 'afraid' }
  | { type: 'craft_recipe'; itemId: string; count: number }
  | { type: 'send_server_command'; command: string }

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
      case 'accept_items':
        return { allowed: true, reason: '只允许拾取明确玩家身边本次可见的掉落物，并验证背包增量' }
      case 'collect_own_drops':
        if (this.#rules.denyTakingPlayerItems) return { allowed: true, reason: '只允许收集本任务产生并由 Fabric 跟踪的掉落物' }
        return { allowed: true, reason: '允许收集掉落物' }
      case 'break_block_at':
        return { allowed: true, reason: 'Fabric 必须再次验证目标为天然方块、Bot 自有方块或玩家本次明确指向的方块' }
      case 'place_block_at':
        return { allowed: true, reason: 'Fabric 必须逐格验证目标、支撑面、附近结构与玩家距离' }
      case 'interact_block':
        return { allowed: true, reason: 'Fabric 必须拒绝未知或玩家所有的容器' }
      case 'step_on_block':
        return { allowed: true, reason: 'Fabric 仅允许踩压压力板或绊线，不破坏任何方块' }
      case 'send_server_command':
        return /^(?:tp|teleport)\s+[A-Za-z0-9_]{1,16}$/u.test(action.command)
          ? { allowed: true, reason: '仅允许尝试把自己传送到一个明确玩家；服务器仍会执行权限检查' }
          : { allowed: false, reason: 'Agent 只获准使用 self-to-player 的 tp/teleport 命令' }
      default:
        return { allowed: true, reason: '非破坏性动作' }
    }
  }
}
