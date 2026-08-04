import type { AgentAction } from '../policy/policy-engine.js'

export interface AgentDecision {
  reply: string
  action: AgentAction
  remember?: string
  validationError?: string
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1]
  const source = (fenced ?? text).trim()
  try { return JSON.parse(source) as unknown } catch {
    const start = source.indexOf('{')
    const end = source.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1)) as unknown
    throw new Error('模型未返回有效 JSON')
  }
}

function normalizeAction(value: unknown): { action: AgentAction; error?: string } {
  if (!value || typeof value !== 'object') return { action: { type: 'none' }, error: '模型没有提供结构化动作对象' }
  const action = value as Record<string, unknown>
  const type = typeof action.type === 'string' ? action.type : 'none'
  switch (type) {
    case 'none': return { action: { type: 'none' } }
    case 'stop': return { action: { type: 'stop' } }
    case 'follow_player':
    case 'come_to_player':
    case 'look_at_player':
    case 'attack_player':
      if (typeof action.target !== 'string' || !action.target.trim()) return { action: { type: 'none' }, error: `${type} 缺少 target 玩家名` }
      return { action: { type, target: action.target.trim() } }
    case 'wander': {
      const radius = typeof action.radius === 'number' && Number.isFinite(action.radius) ? Math.max(2, Math.min(16, Math.round(action.radius))) : 6
      return { action: { type: 'wander', radius } }
    }
    case 'eat_best_food': return { action: { type: 'eat_best_food' } }
    case 'attack_hostile':
      return { action: { type: 'attack_hostile', ...(typeof action.targetId === 'string' && action.targetId.trim() ? { targetId: action.targetId.trim() } : {}) } }
    case 'equip_best':
    case 'prepare_for': {
      const purpose = String(action.purpose ?? 'general')
      if (!['general', 'mining', 'combat', 'end_combat'].includes(purpose)) return { action: { type: 'none' }, error: `${type} 的 purpose 无效` }
      return { action: { type, purpose: purpose as 'general' | 'mining' | 'combat' | 'end_combat' } }
    }
    case 'collect_own_drops': {
      const count = integer(action.count, 1, 64, 1)
      const radius = integer(action.radius, 2, 16, 8)
      return { action: { type, count, radius, ...(typeof action.itemId === 'string' && action.itemId.trim() ? { itemId: action.itemId.trim() } : {}) } }
    }
    case 'gather_resource':
    case 'break_block':
    case 'mine_block':
    case 'break_natural_block': {
      const resource = [action.resource, action.block, action.blockId]
        .find(candidate => typeof candidate === 'string' && candidate.trim())
      if (typeof resource !== 'string') return { action: { type: 'none' }, error: `${type} 缺少 resource 或 block` }
      // Every model-facing mining alias is deliberately normalised to the same guarded primitive.
      // The model cannot provide ownership evidence or a coordinate; Fabric selects and verifies
      // the matching natural block inside the administrator-approved development zone.
      return { action: { type: 'gather_resource', resource: resource.trim().slice(0, 80), count: integer(action.count, 1, 64, 1) } }
    }
    case 'craft_item':
      if (typeof action.itemId !== 'string' || !action.itemId.trim()) return { action: { type: 'none' }, error: 'craft_item 缺少 itemId' }
      return { action: { type, itemId: action.itemId.trim(), count: integer(action.count, 1, 64, 1) } }
    case 'use_item':
      return { action: { type, ...(typeof action.itemId === 'string' && action.itemId.trim() ? { itemId: action.itemId.trim() } : {}) } }
    case 'seek_shelter': return { action: { type: 'seek_shelter' } }
    case 'build_shelter': return { action: { type: 'build_shelter' } }
    case 'wait_safe': return { action: { type: 'wait_safe' } }
    case 'open_container':
      if (!['player', 'unknown'].includes(String(action.ownership))) return { action: { type: 'none' }, error: 'open_container 缺少可验证归属' }
      return { action: { type: 'open_container', ownership: action.ownership as 'player' | 'unknown' } }
    default: return { action: { type: 'none' }, error: `当前客户端不支持动作 ${type}` }
  }
}

function integer(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.round(value))) : fallback
}

function cleanChat(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\r\n]+/gu, ' ').trim().slice(0, 240)
}

export function parseAgentDecision(text: string): AgentDecision {
  const parsed = extractJson(text)
  if (!parsed || typeof parsed !== 'object') throw new Error('模型 JSON 必须是对象')
  const root = parsed as Record<string, unknown>
  const reply = cleanChat(root.reply)
  const remember = cleanChat(root.remember)
  const normalized = normalizeAction(root.action)
  return { reply, action: normalized.action, ...(remember ? { remember } : {}), ...(normalized.error ? { validationError: normalized.error } : {}) }
}
