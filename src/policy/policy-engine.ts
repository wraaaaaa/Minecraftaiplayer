import type { BehaviorRules } from '../config/types.js'

export type AgentAction =
  | { type: 'none' }
  | { type: 'stop' }
  | { type: 'follow_player'; target: string }
  | { type: 'come_to_player'; target: string }
  | { type: 'look_at_player'; target: string }
  | { type: 'wander'; radius: number }
  | { type: 'attack_player'; target: string }
  | { type: 'eat_best_food' }
  | { type: 'equip_best'; purpose: 'general' | 'mining' | 'combat' | 'end_combat' }
  | { type: 'attack_hostile'; targetId?: string }
  | { type: 'collect_own_drops'; itemId?: string; count: number; radius: number }
  | { type: 'gather_resource'; resource: string; count: number }
  | { type: 'craft_item'; itemId: string; count: number }
  | { type: 'use_item'; itemId?: string }
  | { type: 'seek_shelter' }
  | { type: 'build_shelter' }
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
      case 'build_shelter':
        if (!this.#rules.wildernessDevelopmentOnly) return { allowed: true, reason: '运行时仍需验证目标方块与区域' }
        return { allowed: true, reason: '仅在 Fabric 验证为安全荒野开发区后允许' }
      case 'collect_own_drops':
        if (this.#rules.denyTakingPlayerItems) return { allowed: true, reason: '只允许收集本任务产生并由 Fabric 跟踪的掉落物' }
        return { allowed: true, reason: '允许收集掉落物' }
      default:
        return { allowed: true, reason: '非破坏性动作' }
    }
  }
}
