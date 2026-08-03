import type { AgentAction } from '../policy/policy-engine.js'

export interface AgentDecision {
  reply: string
  action: AgentAction
  remember?: string
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

function normalizeAction(value: unknown): AgentAction {
  if (!value || typeof value !== 'object') return { type: 'none' }
  const action = value as Record<string, unknown>
  const type = typeof action.type === 'string' ? action.type : 'none'
  switch (type) {
    case 'none': return { type: 'none' }
    case 'stop': return { type: 'stop' }
    case 'follow_player':
    case 'come_to_player':
    case 'look_at_player':
    case 'attack_player':
      if (typeof action.target !== 'string' || !action.target.trim()) return { type: 'none' }
      return { type, target: action.target.trim() }
    case 'wander': {
      const radius = typeof action.radius === 'number' && Number.isFinite(action.radius) ? Math.max(2, Math.min(16, Math.round(action.radius))) : 6
      return { type: 'wander', radius }
    }
    case 'break_block':
      if (typeof action.block !== 'string' || !['natural', 'player', 'unknown'].includes(String(action.ownership))) return { type: 'none' }
      return { type: 'break_block', block: action.block, ownership: action.ownership as 'natural' | 'player' | 'unknown' }
    case 'open_container':
      if (!['player', 'unknown'].includes(String(action.ownership))) return { type: 'none' }
      return { type: 'open_container', ownership: action.ownership as 'player' | 'unknown' }
    default: return { type: 'none' }
  }
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
  return { reply, action: normalizeAction(root.action), ...(remember ? { remember } : {}) }
}
