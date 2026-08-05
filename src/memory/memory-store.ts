import { randomUUID } from 'node:crypto'
import { AtomicJsonFile } from '../core/atomic-json-file.js'

export interface MemoryEvent {
  id: string
  at: string
  type: 'player_message' | 'bot_reply' | 'game_event' | 'fact'
  playerKey?: string
  content: string
  metadata?: Record<string, string | number | boolean | null>
}

export interface PlayerMemory {
  key: string
  uuid?: string
  currentName: string
  knownNames: string[]
  firstSeenAt: string
  lastSeenAt: string
  facts: string[]
  conversationSummary: string
  lastCompressedAt?: string
}

export interface MemoryDocument {
  schemaVersion: 1
  botName: string
  createdAt: string
  updatedAt: string
  players: Record<string, PlayerMemory>
  events: MemoryEvent[]
  globalSummary: string
  compressionCount?: number
}

export interface PlayerIdentity {
  name: string
  uuid?: string
}

export interface MemoryCompressionCandidate {
  player: PlayerMemory
  olderEvents: MemoryEvent[]
  recentEvents: MemoryEvent[]
  globalSummary: string
}

function now(): string { return new Date().toISOString() }

function playerKey(identity: PlayerIdentity): string {
  return identity.uuid?.trim() ? `uuid:${identity.uuid.toLowerCase()}` : `name:${identity.name.toLowerCase()}`
}

export class MemoryStore {
  readonly #file: AtomicJsonFile<MemoryDocument>
  readonly #botName: string
  readonly #maxEvents: number

  constructor(file: string, botName: string, maxEvents: number) {
    this.#botName = botName
    this.#maxEvents = maxEvents
    this.#file = new AtomicJsonFile(file, () => ({
      schemaVersion: 1,
      botName,
      createdAt: now(),
      updatedAt: now(),
      players: {},
      events: [],
      globalSummary: ''
    }))
  }

  get file(): string { return this.#file.file }
  async load(): Promise<MemoryDocument> { return this.#file.load() }

  async observePlayer(identity: PlayerIdentity): Promise<PlayerMemory> {
    const key = playerKey(identity)
    const document = await this.#file.update((memory) => {
      const timestamp = now()
      const existing = memory.players[key]
      if (existing) {
        existing.lastSeenAt = timestamp
        if (!existing.knownNames.includes(identity.name)) existing.knownNames.push(identity.name)
        existing.currentName = identity.name
        if (identity.uuid) existing.uuid = identity.uuid
      } else {
        memory.players[key] = {
          key,
          ...(identity.uuid ? { uuid: identity.uuid } : {}),
          currentName: identity.name,
          knownNames: [identity.name],
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          facts: [],
          conversationSummary: ''
        }
      }
      memory.updatedAt = timestamp
      memory.botName = this.#botName
    })
    return document.players[key] as PlayerMemory
  }

  async recordPlayerMessage(identity: PlayerIdentity, content: string): Promise<void> {
    const player = await this.observePlayer(identity)
    await this.#append({ type: 'player_message', playerKey: player.key, content })
  }

  async recordBotReply(identity: PlayerIdentity, content: string): Promise<void> {
    const player = await this.observePlayer(identity)
    await this.#append({ type: 'bot_reply', playerKey: player.key, content })
  }

  async recordGameEvent(content: string, metadata?: MemoryEvent['metadata']): Promise<void> {
    await this.#append({ type: 'game_event', content, ...(metadata ? { metadata } : {}) })
  }

  async rememberFact(identity: PlayerIdentity, fact: string): Promise<void> {
    const key = playerKey(identity)
    await this.observePlayer(identity)
    await this.#file.update((memory) => {
      const player = memory.players[key]
      if (player && !player.facts.includes(fact)) player.facts.push(fact)
      memory.events.push({ id: randomUUID(), at: now(), type: 'fact', playerKey: key, content: fact })
      this.#trim(memory)
      memory.updatedAt = now()
    })
  }

  async contextFor(identity: PlayerIdentity, recentLimit = 12): Promise<{ player: PlayerMemory; recentEvents: MemoryEvent[]; globalSummary: string }> {
    const player = await this.observePlayer(identity)
    const memory = await this.#file.load()
    const recentEvents = memory.events.filter((event) => !event.playerKey || event.playerKey === player.key).slice(-recentLimit)
    return { player, recentEvents, globalSummary: memory.globalSummary }
  }

  async compressionCandidate(identity: PlayerIdentity, keepRecent: number): Promise<MemoryCompressionCandidate> {
    const player = await this.observePlayer(identity)
    const memory = await this.#file.load()
    const relevant = memory.events.filter(event => !event.playerKey || event.playerKey === player.key)
    const split = Math.max(0, relevant.length - Math.max(1, keepRecent))
    return {
      player,
      olderEvents: relevant.slice(0, split),
      recentEvents: relevant.slice(split),
      globalSummary: memory.globalSummary
    }
  }

  async compactPlayer(identity: PlayerIdentity, value: { conversationSummary: string; globalSummary: string; compressedEventIds: string[] }): Promise<void> {
    const key = playerKey(identity)
    const ids = new Set(value.compressedEventIds)
    if (ids.size === 0) return
    await this.observePlayer(identity)
    await this.#file.update(memory => {
      const player = memory.players[key]
      if (!player) return
      player.conversationSummary = value.conversationSummary.trim().slice(0, 8_000)
      player.lastCompressedAt = now()
      memory.globalSummary = value.globalSummary.trim().slice(0, 8_000)
      memory.events = memory.events.filter(event => !ids.has(event.id))
      memory.compressionCount = (memory.compressionCount ?? 0) + 1
      memory.updatedAt = now()
    })
  }

  async #append(event: Omit<MemoryEvent, 'id' | 'at'>): Promise<void> {
    await this.#file.update((memory) => {
      memory.events.push({ id: randomUUID(), at: now(), ...event })
      this.#trim(memory)
      memory.updatedAt = now()
    })
  }

  #trim(memory: MemoryDocument): void {
    if (memory.events.length > this.#maxEvents) memory.events.splice(0, memory.events.length - this.#maxEvents)
  }
}
