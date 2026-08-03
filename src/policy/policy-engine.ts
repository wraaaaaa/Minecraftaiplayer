import type { BehaviorRules } from '../config/types.js'

export type AgentAction =
  | { type: 'none' }
  | { type: 'stop' }
  | { type: 'follow_player'; target: string }
  | { type: 'come_to_player'; target: string }
  | { type: 'look_at_player'; target: string }
  | { type: 'wander'; radius: number }
  | { type: 'attack_player'; target: string }
  | { type: 'break_block'; block: string; ownership: 'natural' | 'player' | 'unknown' }
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
        if (action.ownership === 'player' && this.#rules.denyBreakingPlayerProperty) return { allowed: false, reason: '禁止破坏玩家财产' }
        if (action.ownership === 'unknown' && !this.#rules.allowDestructiveActionsWhenOwnershipUnknown) return { allowed: false, reason: '无法确认归属时禁止破坏' }
        return { allowed: true, reason: '允许处理已确认的自然方块' }
      case 'open_container':
        if (action.ownership === 'player' && this.#rules.denyOpeningPlayerContainers) return { allowed: false, reason: '禁止打开玩家容器' }
        if (action.ownership === 'unknown') return { allowed: false, reason: '无法确认归属时禁止打开容器' }
        return { allowed: true, reason: '允许' }
      default:
        return { allowed: true, reason: '非破坏性动作' }
    }
  }
}
