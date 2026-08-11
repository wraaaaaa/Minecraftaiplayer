import type { WorldState } from './world-state.js'
import type { PlayerIdentity } from '../memory/memory-store.js'

export interface AddressingOptions {
  botNames: string[]
  requireMention: boolean
  contextual: boolean
  directDistance: number
  conversationWindowMs: number
}

export interface AddressingResult {
  addressed: boolean
  cleaned: string
  confidence: number
  evidence: string[]
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') }

function uniqueNames(base: readonly string[], extra: readonly string[]): string[] {
  return [...new Set([...base, ...extra].map(name => name.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
}

function commandLike(text: string): boolean {
  const normalized = text.trim()
  return /^(?:你|麻烦|请|帮|陪|跟|过来|来|走|停|别|不用|不要|不需要|算了|去|回来|看|打|攻击|保护|采|挖|收集|做|合成|造|建|吃|用|给|等|守|准备|我们|咱们)|[?？]$/u.test(normalized)
}

export class AddressingEngine {
  readonly #options: AddressingOptions
  readonly #lastConversation = new Map<string, number>()

  constructor(options: AddressingOptions) { this.#options = options }

  decide(identity: PlayerIdentity, message: string, world: WorldState, now = Date.now(), aliases: readonly string[] = []): AddressingResult {
    const evidence: string[] = []
    const trimmed = message.trim()
    const names = uniqueNames(this.#options.botNames, aliases)
    const explicitName = names.find(name => new RegExp(`@?${escapeRegExp(name)}`, 'iu').test(trimmed))
    const forced = trimmed.startsWith('!')
    const cleaned = this.#stripNames(forced ? trimmed.slice(1) : trimmed, names)
    if (forced || explicitName) {
      evidence.push(forced ? '显式 ! 指令' : `明确称呼 ${explicitName}`)
      this.#note(identity, now)
      return { addressed: true, cleaned: cleaned || trimmed, confidence: 1, evidence }
    }
    if (!this.#options.requireMention && !this.#options.contextual) {
      evidence.push('配置为接收全部聊天')
      this.#note(identity, now)
      return { addressed: true, cleaned: trimmed, confidence: 0.9, evidence }
    }
    if (!this.#options.contextual) return { addressed: false, cleaned: trimmed, confidence: 0, evidence: ['当前要求明确点名'] }

    const key = identity.uuid ? `uuid:${identity.uuid}` : `name:${identity.name.toLowerCase()}`
    const lastConversation = this.#lastConversation.get(key)
    const continued = lastConversation !== undefined && now - lastConversation <= this.#options.conversationWindowMs
    const speaker = world.nearbyPlayers.find(player => player.name.toLowerCase() === identity.name.toLowerCase())
    const distance = speaker?.distance ?? Number.POSITIVE_INFINITY
    const nearbyOthers = world.nearbyPlayers.filter(player => player.name.toLowerCase() !== identity.name.toLowerCase() && player.distance <= this.#options.directDistance)
    const namedOther = nearbyOthers.find(player => new RegExp(`@?${escapeRegExp(player.name)}`, 'iu').test(trimmed))
    if (namedOther) return { addressed: false, cleaned: trimmed, confidence: 0.05, evidence: [`消息明确称呼了 ${namedOther.name}`] }
    if (continued && distance <= this.#options.directDistance * 2) {
      evidence.push('同一玩家正在延续刚才的近距离对话')
      this.#note(identity, now)
      return { addressed: true, cleaned: trimmed, confidence: 0.9, evidence }
    }
    if (distance <= this.#options.directDistance && commandLike(trimmed)) {
      const closestDistance = Math.min(...world.nearbyPlayers.map(player => player.distance), Number.POSITIVE_INFINITY)
      const closest = distance <= closestDistance + 0.5
      if (closest || nearbyOthers.length === 0) {
        evidence.push(`发言者距 Bot ${distance.toFixed(1)} 格`, closest ? '发言者是最近玩家' : '附近没有其他可能接收者', '语句像直接提问或指令')
        this.#note(identity, now)
        return { addressed: true, cleaned: trimmed, confidence: nearbyOthers.length === 0 ? 0.9 : 0.82, evidence }
      }
    }
    return { addressed: false, cleaned: trimmed, confidence: 0.2, evidence: ['未点名且缺少足够的近距离对话证据'] }
  }

  noteBotReply(identity: PlayerIdentity, now = Date.now()): void { this.#note(identity, now) }

  #note(identity: PlayerIdentity, at: number): void {
    this.#lastConversation.set(identity.uuid ? `uuid:${identity.uuid}` : `name:${identity.name.toLowerCase()}`, at)
  }

  #stripNames(message: string, names: readonly string[]): string {
    let cleaned = message
    for (const name of names) cleaned = cleaned.replace(new RegExp(`@?${escapeRegExp(name)}`, 'giu'), '')
    return cleaned.trim().replace(/^[,，、:：\s]+/u, '')
  }
}
