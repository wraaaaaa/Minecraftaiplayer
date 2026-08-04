import { createServer, type Server, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import type { AgentAction, PolicyEngine } from '../policy/policy-engine.js'
import type { ActionExecutor } from '../agent/agent-controller.js'
import type { WorldState } from '../agent/world-state.js'
import type { BotConfig, Persona } from '../config/types.js'
import type { Logger } from '../core/logger.js'
import type { MemoryStore, PlayerIdentity } from '../memory/memory-store.js'
import type { RuntimeStatus } from '../runtime/status-store.js'
import { parseDecoratedPlayerChat } from './chat-parser.js'

type PlayerMessageHandler = (identity: PlayerIdentity, message: string, world: WorldState) => Promise<void>
type ProactiveHandler = (world: WorldState) => Promise<void>
type ActionResult = { ok: boolean; detail: string }
type PendingAction = { resolve: (result: ActionResult) => void; timer: NodeJS.Timeout }

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
  dimension?: string
  timeOfDay?: number
  inventory?: Array<{ name?: string; count?: number }>
  nearbyPlayers?: Array<{ name?: string; distance?: number }>
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') }

export class FabricBridgeClient implements ActionExecutor {
  readonly #config: BotConfig
  readonly #persona: Persona
  readonly #logger: Logger
  readonly #memory: MemoryStore
  readonly #policy: PolicyEngine
  readonly #pending = new Map<string, PendingAction>()
  readonly #statusHandler: (phase: RuntimeStatus['phase'], world: WorldState) => Promise<void>
  #server?: Server
  #socket: Socket | undefined
  #buffer = ''
  #world: WorldState = { connected: false, inventory: [], nearbyPlayers: [] }
  #messageHandler: PlayerMessageHandler | undefined
  #proactiveHandler: ProactiveHandler | undefined
  #proactiveTimer: NodeJS.Timeout | undefined
  #connectResolve: (() => void) | undefined
  #connectReject: ((error: Error) => void) | undefined
  #endResolve: ((reason: string) => void) | undefined
  #connected = false
  #closing = false
  readonly #recentPlayerChats = new Map<string, number>()

  constructor(options: { config: BotConfig; persona: Persona; logger: Logger; memory: MemoryStore; policy: PolicyEngine; statusHandler: (phase: RuntimeStatus['phase'], world: WorldState) => Promise<void> }) {
    this.#config = options.config
    this.#persona = options.persona
    this.#logger = options.logger
    this.#memory = options.memory
    this.#policy = options.policy
    this.#statusHandler = options.statusHandler
  }

  setMessageHandler(handler: PlayerMessageHandler): void { this.#messageHandler = handler }
  setProactiveHandler(handler: ProactiveHandler): void { this.#proactiveHandler = handler }

  async connect(): Promise<void> {
    const { bridgeHost, bridgePort, connectTimeoutMs } = this.#config.server
    if (!['127.0.0.1', '::1', 'localhost'].includes(bridgeHost)) {
      throw new Error('Fabric 桥默认只允许监听本机回环地址')
    }
    this.#closing = false
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

  waitForEnd(): Promise<string> { return new Promise((resolve) => { this.#endResolve = resolve }) }

  snapshot(): WorldState { return structuredClone(this.#world) }

  async close(reason = 'shutdown'): Promise<void> {
    this.#closing = true
    if (this.#proactiveTimer) clearInterval(this.#proactiveTimer)
    this.#proactiveTimer = undefined
    this.#failPending(`桥接已关闭: ${reason}`)
    this.#socket?.destroy()
    await new Promise<void>((resolve) => {
      if (!this.#server?.listening) return resolve()
      this.#server.close(() => resolve())
    })
  }

  async chat(message: string): Promise<void> {
    const sanitized = message.replace(/[\r\n]+/gu, ' ').trim().slice(0, 240)
    if (!sanitized) return
    const result = await this.#sendAction({ type: 'chat', message: sanitized })
    if (!result.ok) throw new Error(result.detail)
  }

  async execute(action: AgentAction): Promise<ActionResult> {
    const decision = this.#policy.authorize(action)
    if (!decision.allowed) return { ok: false, detail: decision.reason }
    return this.#sendAction(action)
  }

  #accept(socket: Socket): void {
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
    switch (message.type) {
      case 'hello':
        if (message.protocolVersion !== 1) {
          this.#socket?.destroy(new Error(`不支持的桥协议版本: ${message.protocolVersion}`))
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
        if (!this.#proactiveTimer) {
          this.#proactiveTimer = setInterval(() => {
            if (this.#proactiveHandler) void this.#proactiveHandler(this.snapshot()).catch((error) => this.#logger.warn('空闲任务失败', error))
          }, 15000)
          this.#proactiveTimer.unref()
        }
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
    this.#world = {
      connected: message.connected === true,
      ...(position && typeof position.x === 'number' && typeof position.y === 'number' && typeof position.z === 'number'
        ? { position: { x: position.x, y: position.y, z: position.z } }
        : {}),
      ...(typeof message.health === 'number' ? { health: message.health } : {}),
      ...(typeof message.food === 'number' ? { food: message.food } : {}),
      ...(typeof message.dimension === 'string' ? { dimension: message.dimension } : {}),
      ...(typeof message.timeOfDay === 'number' ? { timeOfDay: message.timeOfDay } : {}),
      inventory: (message.inventory ?? []).flatMap((item) => typeof item.name === 'string' && typeof item.count === 'number' ? [{ name: item.name, count: item.count }] : []),
      nearbyPlayers: (message.nearbyPlayers ?? []).flatMap((player) => typeof player.name === 'string' && typeof player.distance === 'number' ? [{ name: player.name, distance: player.distance }] : [])
    }
    void this.#publishStatus(this.#world.connected ? 'in_world' : 'connected')
  }

  #handlePlayerChat(message: BridgeMessage): void {
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
    const identity: PlayerIdentity = { name: message.name, ...(message.uuid ? { uuid: message.uuid } : {}) }
    if (!this.#isAddressed(message.message)) {
      void this.#memory.recordPlayerMessage(identity, message.message).catch((error) => this.#logger.warn('记录旁听聊天失败', error))
      return
    }
    const cleaned = this.#stripMention(message.message)
    void this.#messageHandler(identity, cleaned || message.message, this.snapshot()).catch((error) => this.#logger.error('玩家消息处理失败', error))
  }

  #handleAttack(message: BridgeMessage): void {
    if (!message.name) return
    this.#policy.noteAttack(message.name)
    void this.#memory.recordGameEvent(`${message.name} 攻击了 Bot`, {
      attacker: message.name,
      ...(message.uuid ? { uuid: message.uuid } : {}),
      ...(typeof this.#world.health === 'number' ? { health: this.#world.health } : {})
    }).catch((error) => this.#logger.warn('记录受击事件失败', error))
  }

  #isAddressed(message: string): boolean {
    if (!this.#config.chat.requireMention || message.startsWith('!')) return true
    const lower = message.toLowerCase()
    return lower.includes(this.#config.server.username.toLowerCase()) || lower.includes(this.#persona.name.toLowerCase())
  }

  #stripMention(message: string): string {
    return message
      .replace(new RegExp(`@?${escapeRegExp(this.#config.server.username)}`, 'giu'), '')
      .replace(new RegExp(`@?${escapeRegExp(this.#persona.name)}`, 'giu'), '')
      .trim()
  }

  #sendAction(action: AgentAction | { type: 'chat'; message: string }): Promise<ActionResult> {
    const socket = this.#socket
    if (!this.#connected || !socket || socket.destroyed) return Promise.resolve({ ok: false, detail: 'Fabric 客户端桥未连接' })
    const id = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        resolve({ ok: false, detail: `Fabric 动作执行超时 (${this.#config.server.actionTimeoutMs}ms)` })
      }, this.#config.server.actionTimeoutMs)
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
    this.#connected = false
    this.#socket = undefined
    this.#world = { connected: false, inventory: [], nearbyPlayers: [] }
    void this.#publishStatus('disconnected')
    if (this.#proactiveTimer) clearInterval(this.#proactiveTimer)
    this.#proactiveTimer = undefined
    this.#failPending('Fabric 客户端连接已断开')
    if (!this.#closing) {
      this.#logger.warn('Fabric 客户端桥已断开')
      this.#endResolve?.('fabric bridge disconnected')
      this.#endResolve = undefined
    }
  }

  #failPending(detail: string): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, detail })
    }
    this.#pending.clear()
  }

  async #publishStatus(phase: RuntimeStatus['phase']): Promise<void> {
    try { await this.#statusHandler(phase, this.snapshot()) }
    catch (error) { this.#logger.warn('写入运行状态失败', error) }
  }
}
