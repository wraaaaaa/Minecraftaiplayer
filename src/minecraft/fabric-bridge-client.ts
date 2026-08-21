import { createServer, type Server, type Socket } from 'node:net'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { AgentAction, PolicyEngine } from '../policy/policy-engine.js'
import type { ActionExecutor } from '../agent/agent-controller.js'
import type { WorldState } from '../agent/world-state.js'
import type { BotConfig, Persona } from '../config/types.js'
import type { Logger } from '../core/logger.js'
import type { MemoryStore, PlayerIdentity } from '../memory/memory-store.js'
import type { RuntimeStatus } from '../runtime/status-store.js'
import { parseDecoratedPlayerChat } from './chat-parser.js'
import { AddressingEngine } from '../agent/addressing.js'
import { autonomyConfig, speechConfig } from '../config/types.js'
import type { SecretGuard } from '../security/secret-guard.js'
import { SpeechService, type PcmSpeech } from '../speech/speech-service.js'

type PlayerMessageHandler = (identity: PlayerIdentity, message: string, world: WorldState) => Promise<void>
type ProactiveHandler = (world: WorldState) => Promise<void>
type AddressAliasesResolver = (identity: PlayerIdentity) => Promise<readonly string[]>
type ActionResult = { ok: boolean; detail: string }
type PendingAction = { resolve: (result: ActionResult) => void; timer: NodeJS.Timeout }
type VoiceBridgeAction =
  | { type: 'voice_playback_begin'; sessionId: string; sampleRate: number; expectedBytes: number }
  | { type: 'voice_playback_chunk'; sessionId: string; sequence: number; data: string }
  | { type: 'voice_playback_end'; sessionId: string }
type InventoryDiscardAction = { type: 'discard_inventory_items'; slots: Array<{ slot: number; count: number }>; authorizedPlayer: string; forceValuable?: boolean }
type BridgeAction = AgentAction | { type: 'chat'; message: string } | VoiceBridgeAction | InventoryDiscardAction

type BridgeMessage = {
  type?: string
  id?: string
  protocolVersion?: number
  name?: string
  uuid?: string
  message?: string
  ok?: boolean
  detail?: string
  connected?: boolean
  position?: { x?: number; y?: number; z?: number }
  health?: number
  food?: number
  maxHealth?: number
  saturation?: number
  experienceLevel?: number
  experienceProgress?: number
  air?: number
  onFire?: boolean
  inWater?: boolean
  onGround?: boolean
  dimension?: string
  timeOfDay?: number
  schemaVersion?: number
  sequence?: number
  seq?: number
  observedAt?: number
  inventory?: Array<{ name?: string; itemId?: string; placeableBlockId?: string; count?: number; slot?: number; durability?: number | { damage?: number; max?: number; remaining?: number }; maxDurability?: number; enchanted?: boolean; foodNutrition?: number; foodSaturation?: number; safeFood?: boolean; enchantments?: Array<{ id?: string; level?: number }>; discardReason?: string; valuable?: boolean }>
  freeSlots?: number
  selectedHotbarSlot?: number
  nearbyBlocks?: Array<{ blockId?: string; x?: number; y?: number; z?: number; distance?: number; resourceCategory?: string; classification?: string; blockEntity?: boolean; replaceable?: boolean; fluid?: boolean; destroySpeed?: number }>
  blockSurvey?: {
    radius?: number
    verticalRadius?: number
    sampledBlocks?: number
    solidBlocks?: number
    blockEntityCount?: number
    center?: { x?: number; y?: number; z?: number }
    resources?: Array<{ blockId?: string; category?: string; count?: number; nearestDistance?: number; nearest?: { x?: number; y?: number; z?: number } }>
    artificial?: Array<{ blockId?: string; category?: string; count?: number; nearestDistance?: number; nearest?: { x?: number; y?: number; z?: number } }>
    owned?: Array<{ blockId?: string; category?: string; count?: number; nearestDistance?: number; nearest?: { x?: number; y?: number; z?: number } }>
    other?: Array<{ blockId?: string; category?: string; count?: number; nearestDistance?: number; nearest?: { x?: number; y?: number; z?: number } }>
    classification?: string
    protectedLikely?: boolean
    reasons?: string[]
  }
  equipment?: Record<string, { name?: string; itemId?: string; count?: number; durability?: number; maxDurability?: number; enchanted?: boolean } | null> | Array<{ slot?: string; name?: string; itemId?: string; count?: number; durability?: { damage?: number; max?: number; remaining?: number }; enchantments?: Array<{ id?: string; level?: number }> }>
  nearbyPlayers?: Array<{ name?: string; uuid?: string; distance?: number; health?: number; position?: { x?: number; y?: number; z?: number }; lookingAtBlock?: { blockId?: string; x?: number; y?: number; z?: number; distance?: number } }>
  ownerWaypoint?: { name?: string; uuid?: string; bearingDegrees?: number; distance?: number; precision?: string }
  nearbyHostiles?: Array<{ id?: string; typeId?: string; name?: string; distance?: number; health?: number; targetingBot?: boolean; targetPlayerName?: string; position?: { x?: number; y?: number; z?: number } }>
  nearbyCreatures?: Array<{ id?: string; typeId?: string; name?: string; distance?: number; health?: number; position?: { x?: number; y?: number; z?: number }; baby?: boolean; tamed?: boolean; leashed?: boolean; customNamed?: boolean; inWater?: boolean }>
  nearbyItems?: Array<{ id?: string; itemId?: string; count?: number; distance?: number }>
  environment?: { isNight?: boolean; blockLight?: number; skyLight?: number; skyVisible?: boolean; safeToIdle?: boolean; safetyReasons?: string[] }
  activePrimitive?: string
  navigationStatus?: string
  home?: { dimension?: string; x?: number; y?: number; z?: number; radius?: number; source?: 'first_home' | 'registered_shelter'; doorX?: number; doorY?: number; doorZ?: number; persisted?: boolean }
  token?: string
  survivalMode?: string
  safeToIdle?: boolean
  safetyReasons?: string[]
  physical?: { air?: number; onFire?: boolean; inWater?: boolean; onGround?: boolean }
  hostiles?: Array<{ entityId?: number; typeId?: string; distance?: number; health?: number; targetingPlayer?: boolean; currentThreat?: boolean; targetPlayerName?: string; position?: { x?: number; y?: number; z?: number } }>
  creatures?: Array<{ entityId?: number; typeId?: string; name?: string; distance?: number; health?: number; position?: { x?: number; y?: number; z?: number }; baby?: boolean; tamed?: boolean; leashed?: boolean; customNamed?: boolean; inWater?: boolean }>
  drops?: Array<{ entityId?: number; itemId?: string; count?: number; distance?: number }>
}

export class FabricBridgeClient implements ActionExecutor {
  readonly #config: BotConfig
  readonly #persona: Persona
  readonly #logger: Logger
  readonly #memory: MemoryStore
  readonly #policy: PolicyEngine
  readonly #secrets: SecretGuard
  readonly #addressing: AddressingEngine
  readonly #speech: SpeechService
  readonly #expectedToken: string
  readonly #ownerName: string
  readonly #pending = new Map<string, PendingAction>()
  readonly #statusHandler: (phase: RuntimeStatus['phase'], world: WorldState) => Promise<void>
  #server?: Server
  #socket: Socket | undefined
  #buffer = ''
  #world: WorldState = { connected: false, inventory: [], nearbyPlayers: [] }
  #messageHandler: PlayerMessageHandler | undefined
  #addressAliasesResolver: AddressAliasesResolver | undefined
  #proactiveHandler: ProactiveHandler | undefined
  #proactiveTimer: NodeJS.Timeout | undefined
  #connectResolve: (() => void) | undefined
  #connectReject: ((error: Error) => void) | undefined
  #endResolve: ((reason: string) => void) | undefined
  #endedReason: string | undefined
  #connected = false
  #closing = false
  readonly #recentPlayerChats = new Map<string, number>()

  constructor(options: { config: BotConfig; persona: Persona; logger: Logger; memory: MemoryStore; policy: PolicyEngine; secrets: SecretGuard; statusHandler: (phase: RuntimeStatus['phase'], world: WorldState) => Promise<void> }) {
    this.#config = options.config
    this.#persona = options.persona
    this.#logger = options.logger
    this.#memory = options.memory
    this.#policy = options.policy
    this.#secrets = options.secrets
    const autonomy = autonomyConfig(options.config)
    this.#ownerName = autonomy.ownerName
    this.#addressing = new AddressingEngine({ botNames: [options.config.server.username, options.persona.name], requireMention: options.config.chat.requireMention, contextual: autonomy.contextualAddressing, directDistance: autonomy.directAddressDistance, conversationWindowMs: autonomy.conversationWindowMs })
    const bridgeSessionCredential = process.env.MCAI_BRIDGE_TOKEN?.trim() ?? ''
    this.#expectedToken = bridgeSessionCredential
    this.#statusHandler = options.statusHandler
    this.#speech = new SpeechService({
      config: speechConfig(options.config),
      logger: options.logger,
      playback: speech => this.#playVoice(speech)
    })
  }

  setMessageHandler(handler: PlayerMessageHandler): void { this.#messageHandler = handler }
  setProactiveHandler(handler: ProactiveHandler): void { this.#proactiveHandler = handler }
  setAddressAliasesResolver(resolver: AddressAliasesResolver): void { this.#addressAliasesResolver = resolver }

  async connect(): Promise<void> {
    const { bridgeHost, bridgePort, connectTimeoutMs } = this.#config.server
    if (!['127.0.0.1', '::1', 'localhost'].includes(bridgeHost)) {
      throw new Error('Fabric 桥默认只允许监听本机回环地址')
    }
    this.#closing = false
    this.#endedReason = undefined
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#connectReject = undefined
        this.#connectResolve = undefined
        if (this.#server?.listening) this.#server.close()
        reject(new Error(`等待 Fabric 客户端桥接超时 (${connectTimeoutMs}ms)`))
      }, connectTimeoutMs)
      timeout.unref()
      this.#connectResolve = () => { clearTimeout(timeout); resolve() }
      this.#connectReject = (error) => { clearTimeout(timeout); reject(error) }
      const server = createServer((socket) => this.#accept(socket))
      this.#server = server
      server.once('error', (error) => {
        this.#connectReject?.(error)
        this.#connectReject = undefined
        this.#connectResolve = undefined
      })
      server.listen(bridgePort, bridgeHost, () => {
        this.#logger.info('Fabric 本机桥已就绪', { host: bridgeHost, port: bridgePort })
      })
    })
  }

  waitForEnd(): Promise<string> {
    if (this.#endedReason !== undefined) return Promise.resolve(this.#endedReason)
    return new Promise((resolve) => { this.#endResolve = resolve })
  }

  snapshot(): WorldState { return structuredClone(this.#world) }

  async close(reason = 'shutdown'): Promise<void> {
    this.#closing = true
    this.#connectReject?.(new Error(`Fabric 桥已关闭：${reason}`))
    this.#connectReject = undefined
    this.#connectResolve = undefined
    this.#speech.close()
    if (this.#proactiveTimer) clearInterval(this.#proactiveTimer)
    this.#proactiveTimer = undefined
    this.#failPending(`桥接已关闭: ${reason}`)
    this.#socket?.destroy()
    await new Promise<void>((resolve) => {
      if (!this.#server?.listening) return resolve()
      this.#server.close(() => resolve())
    })
    this.#finishEnd(reason)
  }

  async chat(message: string): Promise<void> {
    const sanitized = message.replace(/[\r\n]+/gu, ' ').trim().slice(0, 240)
    if (!sanitized) return
    const result = await this.#sendAction({ type: 'chat', message: sanitized })
    if (!result.ok) throw new Error(result.detail)
    this.#speech.enqueue(sanitized)
  }

  async execute(action: AgentAction): Promise<ActionResult> {
    const decision = this.#policy.authorize(action)
    if (!decision.allowed) return { ok: false, detail: decision.reason }
    return this.#sendAction(action)
  }

  /** 仪表盘背包整理：按槽位丢弃并后退，绕过模型直接执行；authorizedPlayer 固定为主人，贵重物品需显式 forceValuable。 */
  async discardInventory(slots: Array<{ slot: number; count: number }>, forceValuable = false): Promise<ActionResult> {
    return this.#sendAction({ type: 'discard_inventory_items', slots, authorizedPlayer: this.#ownerName, forceValuable })
  }

  #accept(socket: Socket): void {
    // 被拒绝的 socket 也必须有 error 监听器，否则 destroy(error) 会以未处理 'error' 事件击穿进程。
    socket.on('error', () => {})
    if (this.#socket && !this.#socket.destroyed) {
      socket.destroy(new Error('只允许一个 Fabric 客户端连接'))
      return
    }
    const remote = socket.remoteAddress?.replace(/^::ffff:/u, '')
    if (remote !== '127.0.0.1' && remote !== '::1') {
      socket.destroy(new Error('拒绝非本机桥接连接'))
      return
    }
    this.#socket = socket
    this.#buffer = ''
    socket.setEncoding('utf8')
    socket.setNoDelay(true)
    socket.on('data', (chunk: string) => this.#onData(chunk))
    socket.on('error', (error) => this.#logger.warn('Fabric 桥连接错误', error))
    socket.on('close', () => this.#onSocketClose())
  }

  #onData(chunk: string): void {
    this.#buffer += chunk
    if (this.#buffer.length > 1_000_000) {
      this.#socket?.destroy(new Error('Fabric 桥消息超过 1MB'))
      return
    }
    let lineEnd = this.#buffer.indexOf('\n')
    while (lineEnd >= 0) {
      const line = this.#buffer.slice(0, lineEnd).trim()
      this.#buffer = this.#buffer.slice(lineEnd + 1)
      if (line) {
        try { this.#handle(JSON.parse(line) as BridgeMessage) }
        catch (error) { this.#logger.warn('忽略无效的 Fabric 桥消息', error) }
      }
      lineEnd = this.#buffer.indexOf('\n')
    }
  }

  #handle(message: BridgeMessage): void {
    if (!this.#connected && message.type !== 'hello') {
      const error = new Error('Fabric 桥必须先完成 hello 握手')
      this.#logger.warn('拒绝了握手前的 Fabric 桥消息', { type: message.type ?? 'missing' })
      this.#rejectHandshake(error)
      return
    }
    switch (message.type) {
      case 'hello':
        if (this.#expectedToken && !this.#validToken(message.token)) {
          this.#logger.warn('拒绝了没有有效会话令牌的本机 Fabric 桥连接')
          this.#rejectHandshake(new Error('Fabric 桥会话令牌无效'))
          return
        }
        if (message.protocolVersion !== 1) {
          this.#rejectHandshake(new Error(`不支持的桥协议版本: ${message.protocolVersion}`))
          return
        }
        this.#connected = true
        this.#connectResolve?.()
        this.#connectResolve = undefined
        this.#connectReject = undefined
        this.#logger.info('Fabric 26.2 客户端已连接本机控制器')
        void this.#publishStatus('connected')
        break
      case 'joined_world':
        this.#world.connected = true
        this.#logger.info('Fabric 客户端已进入世界', { name: message.name, uuid: message.uuid })
        void this.#publishStatus('in_world')
        this.#ensureProactiveTimer()
        break
      case 'state': this.#updateState(message); break
      case 'player_chat': this.#handlePlayerChat(message); break
      case 'game_message': {
        this.#logger.debug('游戏系统消息', { message: message.message })
        const parsed = typeof message.message === 'string' ? parseDecoratedPlayerChat(message.message) : null
        if (parsed) this.#handlePlayerChat({ type: 'player_chat', name: parsed.name, message: parsed.message })
        break
      }
      case 'attacked_by_player': this.#handleAttack(message); break
      case 'voice_status':
        if (message.ok === false) this.#logger.warn('Simple Voice Chat 播放状态异常', { detail: message.detail })
        else this.#logger.debug('Simple Voice Chat 播放状态', { detail: message.detail })
        break
      case 'death':
        this.#logger.warn('Bot 已死亡，等待客户端自动复活')
        void this.#memory.recordGameEvent('Bot 已死亡，等待自动复活', { health: message.health ?? 0 }).catch((error) => this.#logger.warn('记录死亡事件失败', error))
        break
      case 'respawn_requested':
        this.#logger.info('客户端已向服务器请求自动复活')
        break
      case 'respawned':
        this.#logger.info('Bot 已自动复活', { health: message.health })
        void this.#memory.recordGameEvent('Bot 已自动复活', { health: message.health ?? 20 }).catch((error) => this.#logger.warn('记录复活事件失败', error))
        break
      case 'action_result': this.#resolveAction(message); break
    }
  }

  #updateState(message: BridgeMessage): void {
    const position = message.position
    const sequence = message.sequence ?? message.seq
    const air = message.air ?? message.physical?.air
    const onFire = message.onFire ?? message.physical?.onFire
    const inWater = message.inWater ?? message.physical?.inWater
    const onGround = message.onGround ?? message.physical?.onGround
    this.#world = {
      connected: message.connected === true,
      ...(typeof message.schemaVersion === 'number' ? { schemaVersion: message.schemaVersion } : {}),
      ...(typeof sequence === 'number' ? { sequence } : {}),
      ...(typeof message.observedAt === 'number' ? { observedAt: message.observedAt } : {}),
      ...(position && typeof position.x === 'number' && typeof position.y === 'number' && typeof position.z === 'number'
        ? { position: { x: position.x, y: position.y, z: position.z } }
        : {}),
      ...(typeof message.health === 'number' ? { health: message.health } : {}),
      ...(typeof message.maxHealth === 'number' ? { maxHealth: message.maxHealth } : {}),
      ...(typeof message.food === 'number' ? { food: message.food } : {}),
      ...(typeof message.saturation === 'number' ? { saturation: message.saturation } : {}),
      ...(typeof message.experienceLevel === 'number' ? { experienceLevel: message.experienceLevel } : {}),
      ...(typeof message.experienceProgress === 'number' ? { experienceProgress: message.experienceProgress } : {}),
      ...(typeof air === 'number' ? { air } : {}),
      ...(typeof onFire === 'boolean' ? { onFire } : {}),
      ...(typeof inWater === 'boolean' ? { inWater } : {}),
      ...(typeof onGround === 'boolean' ? { onGround } : {}),
      ...(typeof message.dimension === 'string' ? { dimension: message.dimension } : {}),
      ...(typeof message.timeOfDay === 'number' ? { timeOfDay: message.timeOfDay } : {}),
      inventory: (message.inventory ?? []).flatMap((item) => typeof item.name === 'string' && typeof item.count === 'number' ? [{ name: item.name, count: item.count, ...(typeof item.itemId === 'string' ? { itemId: item.itemId } : {}), ...(typeof item.placeableBlockId === 'string' ? { placeableBlockId: item.placeableBlockId } : {}), ...(typeof item.slot === 'number' ? { slot: item.slot } : {}), ...(typeof item.durability === 'number' ? { durability: item.durability } : typeof item.durability?.damage === 'number' ? { durability: item.durability.damage } : {}), ...(typeof item.maxDurability === 'number' ? { maxDurability: item.maxDurability } : typeof item.durability === 'object' && typeof item.durability.max === 'number' ? { maxDurability: item.durability.max } : {}), ...(typeof item.enchanted === 'boolean' ? { enchanted: item.enchanted } : Array.isArray(item.enchantments) ? { enchanted: item.enchantments.length > 0 } : {}), ...(typeof item.foodNutrition === 'number' ? { foodNutrition: item.foodNutrition } : {}), ...(typeof item.foodSaturation === 'number' ? { foodSaturation: item.foodSaturation } : {}), ...(typeof item.safeFood === 'boolean' ? { safeFood: item.safeFood } : {}), ...(Array.isArray(item.enchantments) ? { enchantments: item.enchantments.flatMap(enchantment => typeof enchantment.id === 'string' && typeof enchantment.level === 'number' ? [{ id: enchantment.id, level: enchantment.level }] : []) } : {}), ...(item.valuable === true ? { valuable: true } : {}), ...(item.discardReason === 'worn_tool' || item.discardReason === 'unsafe_food' || item.discardReason === 'filler_excess' || item.discardReason === 'keep' ? { discardReason: item.discardReason } : {}) }] : []),
      ...(typeof message.freeSlots === 'number' ? { freeSlots: message.freeSlots } : {}),
      ...(typeof message.selectedHotbarSlot === 'number' ? { selectedHotbarSlot: message.selectedHotbarSlot } : {}),
      ...(message.nearbyBlocks ? { nearbyBlocks: message.nearbyBlocks.flatMap(block => {
        if (typeof block.blockId !== 'string' || typeof block.x !== 'number' || typeof block.y !== 'number' || typeof block.z !== 'number' || typeof block.distance !== 'number') return []
        const classification = ['natural_resource', 'protected_likely', 'bot_owned', 'unclassified'].includes(block.classification ?? '')
          ? block.classification as 'natural_resource' | 'protected_likely' | 'bot_owned' | 'unclassified'
          : 'unclassified'
        return [{ blockId: block.blockId, x: block.x, y: block.y, z: block.z, distance: block.distance, classification,
          blockEntity: block.blockEntity === true, replaceable: block.replaceable === true, fluid: block.fluid === true,
          destroySpeed: typeof block.destroySpeed === 'number' ? block.destroySpeed : -1,
          ...(typeof block.resourceCategory === 'string' ? { resourceCategory: block.resourceCategory } : {}) }]
      }) } : {}),
      ...(message.equipment ? { equipment: this.#equipment(message.equipment) } : {}),
      nearbyPlayers: (message.nearbyPlayers ?? []).flatMap((player) => {
        if (typeof player.name !== 'string' || typeof player.distance !== 'number') return []
        const pointed = player.lookingAtBlock
        const lookingAtBlock = pointed && typeof pointed.blockId === 'string'
          && typeof pointed.x === 'number' && typeof pointed.y === 'number' && typeof pointed.z === 'number'
          && typeof pointed.distance === 'number'
          ? { blockId: pointed.blockId, x: pointed.x, y: pointed.y, z: pointed.z, distance: pointed.distance }
          : undefined
        const playerPosition = player.position && typeof player.position.x === 'number' && typeof player.position.y === 'number' && typeof player.position.z === 'number'
          ? { x: player.position.x, y: player.position.y, z: player.position.z }
          : undefined
        return [{ name: player.name, distance: player.distance, ...(typeof player.uuid === 'string' ? { uuid: player.uuid } : {}), ...(typeof player.health === 'number' ? { health: player.health } : {}), ...(playerPosition ? { position: playerPosition } : {}), ...(lookingAtBlock ? { lookingAtBlock } : {}) }]
      }),
      ...(message.ownerWaypoint && typeof message.ownerWaypoint.name === 'string'
        && typeof message.ownerWaypoint.bearingDegrees === 'number'
        ? { ownerWaypoint: {
            name: message.ownerWaypoint.name,
            bearingDegrees: message.ownerWaypoint.bearingDegrees,
            precision: ['position', 'chunk', 'azimuth'].includes(message.ownerWaypoint.precision ?? '')
              ? message.ownerWaypoint.precision as 'position' | 'chunk' | 'azimuth'
              : 'unknown',
            ...(typeof message.ownerWaypoint.uuid === 'string' ? { uuid: message.ownerWaypoint.uuid } : {}),
            ...(typeof message.ownerWaypoint.distance === 'number' ? { distance: message.ownerWaypoint.distance } : {})
          } } : {}),
      ...((message.nearbyHostiles || message.hostiles) ? { nearbyHostiles: this.#livingEntities(message.nearbyHostiles ?? message.hostiles ?? [], true) } : {}),
      ...((message.nearbyCreatures || message.creatures) ? { nearbyCreatures: this.#livingEntities(message.nearbyCreatures ?? message.creatures ?? [], false) } : {}),
      ...((message.nearbyItems || message.drops) ? { nearbyItems: message.nearbyItems?.flatMap(entity => typeof entity.id === 'string' && typeof entity.itemId === 'string' && typeof entity.count === 'number' && typeof entity.distance === 'number' ? [{ id: entity.id, itemId: entity.itemId, count: entity.count, distance: entity.distance }] : []) ?? message.drops?.flatMap(entity => typeof entity.entityId === 'number' && typeof entity.itemId === 'string' && typeof entity.count === 'number' && typeof entity.distance === 'number' ? [{ id: String(entity.entityId), itemId: entity.itemId, count: entity.count, distance: entity.distance }] : []) ?? [] } : {}),
      ...(message.blockSurvey ? { blockSurvey: this.#blockSurvey(message.blockSurvey) } : {}),
      ...(message.environment ? { environment: { ...message.environment, ...(typeof (message.environment.isNight ?? (message.environment as { night?: boolean }).night) === 'boolean' ? { isNight: message.environment.isNight ?? (message.environment as { night?: boolean }).night } : {}), ...(typeof (message.environment.skyVisible ?? (message.environment as { canSeeSky?: boolean }).canSeeSky) === 'boolean' ? { skyVisible: message.environment.skyVisible ?? (message.environment as { canSeeSky?: boolean }).canSeeSky } : {}), ...(typeof message.safeToIdle === 'boolean' ? { safeToIdle: message.safeToIdle } : {}), ...(Array.isArray(message.safetyReasons) ? { safetyReasons: message.safetyReasons } : {}) } } : {}),
      ...(message.home && typeof message.home.dimension === 'string' && typeof message.home.x === 'number' && typeof message.home.y === 'number' && typeof message.home.z === 'number' ? { home: { dimension: message.home.dimension, x: message.home.x, y: message.home.y, z: message.home.z, ...(typeof message.home.radius === 'number' ? { radius: message.home.radius } : {}), ...(message.home.source === 'first_home' || message.home.source === 'registered_shelter' ? { source: message.home.source } : {}), ...(typeof message.home.doorX === 'number' ? { doorX: message.home.doorX } : {}), ...(typeof message.home.doorY === 'number' ? { doorY: message.home.doorY } : {}), ...(typeof message.home.doorZ === 'number' ? { doorZ: message.home.doorZ } : {}), ...(typeof message.home.persisted === 'boolean' ? { persisted: message.home.persisted } : {}) } } : {}),
      ...(typeof (message.activePrimitive ?? message.survivalMode) === 'string' ? { activePrimitive: message.activePrimitive ?? message.survivalMode } : {}),
      ...(typeof message.navigationStatus === 'string' ? { navigationStatus: message.navigationStatus } : {})
    }
    if (this.#world.connected) this.#ensureProactiveTimer()
    void this.#publishStatus(this.#world.connected ? 'in_world' : 'connected')
  }

  #ensureProactiveTimer(): void {
    if (this.#proactiveTimer) return
    this.#proactiveTimer = setInterval(() => {
      if (this.#proactiveHandler) void this.#proactiveHandler(this.snapshot()).catch((error) => this.#logger.warn('空闲任务失败', error))
    }, 15000)
    this.#proactiveTimer.unref()
  }

  #equipment(value: NonNullable<BridgeMessage['equipment']>): NonNullable<WorldState['equipment']> {
    if (Array.isArray(value)) {
      return Object.fromEntries(value.flatMap(item => typeof item.slot === 'string' && typeof item.itemId === 'string' && typeof item.name === 'string' && typeof item.count === 'number' ? [[item.slot === 'mainhand' ? 'mainHand' : item.slot === 'offhand' ? 'offHand' : item.slot, { itemId: item.itemId, name: item.name, count: item.count, ...(typeof item.durability?.damage === 'number' ? { durability: item.durability.damage } : {}), ...(typeof item.durability?.max === 'number' ? { maxDurability: item.durability.max } : {}), enchanted: (item.enchantments?.length ?? 0) > 0 }]] : []))
    }
    return Object.fromEntries(Object.entries(value).map(([slot, item]) => [slot, item && typeof item.itemId === 'string' && typeof item.name === 'string' && typeof item.count === 'number' ? { itemId: item.itemId, name: item.name, count: item.count, ...(typeof item.durability === 'number' ? { durability: item.durability } : {}), ...(typeof item.maxDurability === 'number' ? { maxDurability: item.maxDurability } : {}), ...(typeof item.enchanted === 'boolean' ? { enchanted: item.enchanted } : {}) } : null]))
  }

  #livingEntities(input: unknown[], hostile: boolean): Array<{
    id: string; typeId: string; name?: string; distance: number; health?: number
    targetingBot?: boolean; targetPlayerName?: string; position?: { x: number; y: number; z: number }
    baby?: boolean; tamed?: boolean; leashed?: boolean; customNamed?: boolean; inWater?: boolean
  }> {
    return input.flatMap(value => {
      if (!value || typeof value !== 'object') return []
      const entity = value as Record<string, unknown>
      const rawId = entity.id ?? entity.entityId
      if ((typeof rawId !== 'string' && typeof rawId !== 'number') || typeof entity.typeId !== 'string' || typeof entity.distance !== 'number') return []
      const rawPosition = entity.position
      const position = rawPosition && typeof rawPosition === 'object'
        && typeof (rawPosition as Record<string, unknown>).x === 'number'
        && typeof (rawPosition as Record<string, unknown>).y === 'number'
        && typeof (rawPosition as Record<string, unknown>).z === 'number'
        ? {
            x: (rawPosition as { x: number }).x,
            y: (rawPosition as { y: number }).y,
            z: (rawPosition as { z: number }).z
          }
        : undefined
      const targetingBot = entity.targetingBot === true || entity.targetingPlayer === true
      return [{
        id: String(rawId), typeId: entity.typeId, distance: entity.distance,
        ...(typeof entity.name === 'string' ? { name: entity.name } : {}),
        ...(typeof entity.health === 'number' ? { health: entity.health } : {}),
        ...(position ? { position } : {}),
        ...(hostile ? { targetingBot } : {}),
        ...(typeof entity.targetPlayerName === 'string' ? { targetPlayerName: entity.targetPlayerName } : {}),
        ...(typeof entity.baby === 'boolean' ? { baby: entity.baby } : {}),
        ...(typeof entity.tamed === 'boolean' ? { tamed: entity.tamed } : {}),
        ...(typeof entity.leashed === 'boolean' ? { leashed: entity.leashed } : {}),
        ...(typeof entity.customNamed === 'boolean' ? { customNamed: entity.customNamed } : {}),
        ...(typeof entity.inWater === 'boolean' ? { inWater: entity.inWater } : {})
      }]
    })
  }

  #blockSurvey(value: NonNullable<BridgeMessage['blockSurvey']>): NonNullable<WorldState['blockSurvey']> {
    const point = (input: { x?: number; y?: number; z?: number } | undefined): { x: number; y: number; z: number } | undefined =>
      input && typeof input.x === 'number' && typeof input.y === 'number' && typeof input.z === 'number'
        ? { x: input.x, y: input.y, z: input.z }
        : undefined
    const entries = (input: typeof value.resources): NonNullable<WorldState['blockSurvey']>['resources'] =>
      (input ?? []).flatMap((entry) => {
        if (typeof entry.blockId !== 'string' || typeof entry.category !== 'string' || typeof entry.count !== 'number' || typeof entry.nearestDistance !== 'number') return []
        const nearest = point(entry.nearest)
        return [{
          blockId: entry.blockId,
          category: entry.category,
          count: Math.max(0, Math.floor(entry.count)),
          nearestDistance: Math.max(0, entry.nearestDistance),
          ...(nearest ? { nearest } : {})
        }]
      })
    const center = point(value.center) ?? this.#world.position ?? { x: 0, y: 0, z: 0 }
    const classification = value.classification === 'natural_terrain_likely'
      || value.classification === 'protected_structure_nearby'
      || value.classification === 'uncertain'
      ? value.classification
      : 'uncertain'
    return {
      radius: typeof value.radius === 'number' ? Math.max(0, Math.floor(value.radius)) : 0,
      verticalRadius: typeof value.verticalRadius === 'number' ? Math.max(0, Math.floor(value.verticalRadius)) : 0,
      sampledBlocks: typeof value.sampledBlocks === 'number' ? Math.max(0, Math.floor(value.sampledBlocks)) : 0,
      solidBlocks: typeof value.solidBlocks === 'number' ? Math.max(0, Math.floor(value.solidBlocks)) : 0,
      blockEntityCount: typeof value.blockEntityCount === 'number' ? Math.max(0, Math.floor(value.blockEntityCount)) : 0,
      center,
      resources: entries(value.resources),
      artificial: entries(value.artificial),
      owned: entries(value.owned),
      other: entries(value.other),
      classification,
      protectedLikely: value.protectedLikely === true,
      reasons: (value.reasons ?? []).filter((reason): reason is string => typeof reason === 'string').slice(0, 16)
    }
  }

  #handlePlayerChat(message: BridgeMessage): void {
    void this.#processPlayerChat(message).catch(error => this.#logger.error('玩家消息寻址失败', error))
  }

  async #processPlayerChat(message: BridgeMessage): Promise<void> {
    if (!message.name || !message.message || !this.#messageHandler) return
    if (message.name.toLowerCase() === this.#config.server.username.toLowerCase()) return
    const now = Date.now()
    const signature = `${message.name.toLowerCase()}\u0000${message.message}`
    const previous = this.#recentPlayerChats.get(signature)
    if (previous !== undefined && now - previous < 1500) return
    this.#recentPlayerChats.set(signature, now)
    if (this.#recentPlayerChats.size > 100) {
      for (const [key, seenAt] of this.#recentPlayerChats) if (now - seenAt >= 1500) this.#recentPlayerChats.delete(key)
    }
    // 聊天文本常只有玩家名而没有 UUID；从当前世界快照里按名字补全 UUID，
    // 让聊天身份与 Fabric 附近玩家身份统一，避免同一玩家被拆成 name: 与 uuid: 两份记忆。
    const resolvedUuid = message.uuid ?? this.#world.nearbyPlayers.find(player => player.name.toLowerCase() === message.name!.toLowerCase())?.uuid
    const identity: PlayerIdentity = { name: message.name, ...(resolvedUuid ? { uuid: resolvedUuid } : {}) }
    const aliases = await this.#addressAliasesResolver?.(identity) ?? []
    const addressed = this.#addressing.decide(identity, message.message, this.#world, Date.now(), aliases)
    if (!addressed.addressed) {
      await this.#memory.recordPlayerMessage(identity, this.#secrets.sanitizeForPersistence(message.message)).catch((error) => this.#logger.warn('记录旁听聊天失败', error))
      return
    }
    await this.#messageHandler(identity, addressed.cleaned || message.message, this.snapshot())
      .then(() => this.#addressing.noteBotReply(identity))
  }

  #handleAttack(message: BridgeMessage): void {
    if (!message.name) return
    this.#policy.noteAttack(message.name)
    void this.#memory.recordGameEvent(`${message.name} 攻击了 Bot`, {
      attacker: message.name,
      ...(message.uuid ? { uuid: message.uuid } : {}),
      ...(typeof this.#world.health === 'number' ? { health: this.#world.health } : {})
    }).catch((error) => this.#logger.warn('记录受击事件失败', error))
    void this.execute({ type: 'attack_player', target: message.name })
      .then(result => {
        if (!result.ok) this.#logger.warn('自动自卫未执行', { attacker: message.name, reason: result.detail })
      })
      .catch(error => this.#logger.warn('自动自卫动作失败', error))
  }

  async #playVoice(speech: PcmSpeech): Promise<void> {
    const sessionId = randomUUID()
    const begin = await this.#sendAction({ type: 'voice_playback_begin', sessionId, sampleRate: speech.sampleRate, expectedBytes: speech.pcm16le.length })
    if (!begin.ok) throw new Error(begin.detail)
    const chunkBytes = 72 * 1024
    let sequence = 0
    for (let offset = 0; offset < speech.pcm16le.length; offset += chunkBytes) {
      const chunk = speech.pcm16le.subarray(offset, Math.min(offset + chunkBytes, speech.pcm16le.length))
      const result = await this.#sendAction({ type: 'voice_playback_chunk', sessionId, sequence, data: chunk.toString('base64') })
      if (!result.ok) throw new Error(result.detail)
      sequence++
    }
    const end = await this.#sendAction({ type: 'voice_playback_end', sessionId })
    if (!end.ok) throw new Error(end.detail)
  }

  #sendAction(action: BridgeAction): Promise<ActionResult> {
    const socket = this.#socket
    if (!this.#connected || !socket || socket.destroyed) return Promise.resolve({ ok: false, detail: 'Fabric 客户端桥未连接' })
    const id = randomUUID()
    const longRunning = ['navigate_to', 'step_on_block', 'break_block_at', 'place_block_at', 'craft_recipe', 'use_held_item',
      'equip_best', 'prepare_for', 'unequip_armor', 'make_inventory_room', 'use_item', 'collect_own_drops', 'gather_resource', 'craft_item', 'place_block', 'drop_item',
      'accept_items', 'return_home',
      'discard_inventory_items',
      'attack_hostile', 'ranged_attack_continuously', 'hunt_entity', 'smelt_item', 'trade_villager', 'enchant_item', 'sleep_in_bed', 'excavate_tunnel',
      'explore_frontier', 'travel_to_dimension', 'build_nether_portal', 'seek_shelter', 'build_shelter'].includes(action.type)
    const shelterAction = action.type === 'seek_shelter' || action.type === 'build_shelter'
    const veryLongAction = action.type === 'smelt_item' || action.type === 'excavate_tunnel'
    const journeyAction = action.type === 'travel_to_dimension'
    const timeoutMs = longRunning
      ? Math.max(this.#config.server.actionTimeoutMs, journeyAction ? 1_800_000 : veryLongAction ? 600_000 : shelterAction ? 180_000 : 120_000)
      : this.#config.server.actionTimeoutMs
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        if (longRunning && this.#socket && !this.#socket.destroyed) {
          this.#socket.write(`${JSON.stringify({ type: 'action', id: randomUUID(), action: { type: 'stop' } })}\n`, 'utf8')
        }
        resolve({ ok: false, detail: `Fabric 动作执行超时 (${timeoutMs}ms)` })
      }, timeoutMs)
      timer.unref()
      this.#pending.set(id, { resolve, timer })
      socket.write(`${JSON.stringify({ type: 'action', id, action })}\n`, 'utf8', (error) => {
        if (!error) return
        const pending = this.#pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.#pending.delete(id)
        pending.resolve({ ok: false, detail: `Fabric 桥写入失败: ${error.message}` })
      })
    })
  }

  #resolveAction(message: BridgeMessage): void {
    if (!message.id) return
    const pending = this.#pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.#pending.delete(message.id)
    pending.resolve({ ok: message.ok === true, detail: message.detail ?? '未提供执行结果' })
  }

  #onSocketClose(): void {
    const wasConnected = this.#connected
    this.#connected = false
    this.#socket = undefined
    this.#world = { connected: false, inventory: [], nearbyPlayers: [] }
    void this.#publishStatus('disconnected')
    if (this.#proactiveTimer) clearInterval(this.#proactiveTimer)
    this.#proactiveTimer = undefined
    this.#failPending('Fabric 客户端连接已断开')
    if (wasConnected && !this.#closing) {
      this.#logger.warn('Fabric 客户端桥已断开')
      this.#finishEnd('fabric bridge disconnected')
    }
  }

  #finishEnd(reason: string): void {
    if (this.#endedReason !== undefined) return
    this.#endedReason = reason
    this.#endResolve?.(reason)
    this.#endResolve = undefined
  }

  #failPending(detail: string): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, detail })
    }
    this.#pending.clear()
  }

  #rejectHandshake(error: Error): void {
    this.#connectReject?.(error)
    this.#connectReject = undefined
    this.#connectResolve = undefined
    this.#socket?.destroy(error)
  }

  #validToken(candidate: string | undefined): boolean {
    if (!candidate) return false
    const expected = Buffer.from(this.#expectedToken, 'utf8')
    const actual = Buffer.from(candidate, 'utf8')
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }

  async #publishStatus(phase: RuntimeStatus['phase']): Promise<void> {
    try { await this.#statusHandler(phase, this.snapshot()) }
    catch (error) { this.#logger.warn('写入运行状态失败', error) }
  }
}
