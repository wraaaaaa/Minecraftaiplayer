import mineflayer, { type Bot } from 'mineflayer'
import pathfinderPackage from 'mineflayer-pathfinder'
import type { BotConfig, Persona } from '../config/types.js'
import type { Logger } from '../core/logger.js'
import type { MemoryStore, PlayerIdentity } from '../memory/memory-store.js'
import type { AgentAction, PolicyEngine } from '../policy/policy-engine.js'
import type { ActionExecutor } from '../agent/agent-controller.js'
import type { WorldState } from '../agent/world-state.js'
import { EasyAuthController } from './easy-auth.js'
import { AddressingEngine } from '../agent/addressing.js'
import { autonomyConfig } from '../config/types.js'
import type { SecretGuard } from '../security/secret-guard.js'

type PlayerMessageHandler = (identity: PlayerIdentity, message: string, world: WorldState) => Promise<void>
type ProactiveHandler = (world: WorldState) => Promise<void>

const { goals, Movements, pathfinder } = pathfinderPackage

export class MinecraftClient implements ActionExecutor {
  readonly #config: BotConfig
  readonly #persona: Persona
  readonly #logger: Logger
  readonly #memory: MemoryStore
  readonly #policy: PolicyEngine
  readonly #easyAuth: EasyAuthController
  readonly #secrets: SecretGuard
  readonly #addressing: AddressingEngine
  #bot: Bot | undefined
  #messageHandler: PlayerMessageHandler | undefined
  #proactiveHandler: ProactiveHandler | undefined
  #proactiveTimer: NodeJS.Timeout | undefined
  #endResolve: ((reason: string) => void) | undefined

  constructor(options: { config: BotConfig; persona: Persona; logger: Logger; memory: MemoryStore; policy: PolicyEngine; secrets: SecretGuard; easyAuthPassword?: string }) {
    this.#config = options.config
    this.#persona = options.persona
    this.#logger = options.logger
    this.#memory = options.memory
    this.#policy = options.policy
    this.#secrets = options.secrets
    const autonomy = autonomyConfig(options.config)
    this.#addressing = new AddressingEngine({ botNames: [options.config.server.username, options.persona.name], requireMention: options.config.chat.requireMention, contextual: autonomy.contextualAddressing, directDistance: autonomy.directAddressDistance, conversationWindowMs: autonomy.conversationWindowMs })
    this.#easyAuth = new EasyAuthController({ enabled: options.config.easyAuth.enabled, ...(options.easyAuthPassword ? { password: options.easyAuthPassword } : {}), delayMs: options.config.easyAuth.loginDelayMs, logger: options.logger })
  }

  setMessageHandler(handler: PlayerMessageHandler): void { this.#messageHandler = handler }
  setProactiveHandler(handler: ProactiveHandler): void { this.#proactiveHandler = handler }

  async connect(): Promise<void> {
    this.#easyAuth.reset()
    const server = this.#config.server
    const bot = mineflayer.createBot({
      host: server.host,
      port: server.port,
      username: server.username,
      auth: server.auth,
      version: server.version,
      hideErrors: true,
      logErrors: false,
      brand: 'vanilla'
    })
    this.#bot = bot
    bot.loadPlugin(pathfinder)
    this.#wireEvents(bot)
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        if (!settled) { settled = true; bot.quit('connect timeout'); reject(new Error(`连接服务器超时 (${server.connectTimeoutMs}ms)`)) }
      }, server.connectTimeoutMs)
      const onSpawn = (): void => { if (!settled) { settled = true; clearTimeout(timeout); resolve() } }
      const onError = (error: Error): void => { if (!settled) { settled = true; clearTimeout(timeout); reject(error) } }
      const onEnd = (reason: string): void => { if (!settled) { settled = true; clearTimeout(timeout); reject(new Error(`连接在进入世界前结束：${reason}`)) } }
      bot.once('spawn', onSpawn)
      bot.once('error', onError)
      bot.once('end', onEnd)
    })
  }

  waitForEnd(): Promise<string> { return new Promise((resolve) => { this.#endResolve = resolve }) }

  async close(reason = 'shutdown'): Promise<void> {
    if (this.#proactiveTimer) clearInterval(this.#proactiveTimer)
    this.#proactiveTimer = undefined
    this.#bot?.quit(reason)
  }

  snapshot(): WorldState {
    const bot = this.#bot
    if (!bot?.entity) return { connected: false, inventory: [], nearbyPlayers: [] }
    const position = bot.entity.position
    const nearbyPlayers = Object.values(bot.players)
      .filter((player) => player.username !== bot.username && player.entity)
      .map((player) => ({ name: player.username, distance: Math.round(bot.entity.position.distanceTo(player.entity!.position) * 10) / 10 }))
      .filter((player) => player.distance <= 32)
      .sort((a, b) => a.distance - b.distance)
    return {
      connected: true,
      position: { x: Math.round(position.x * 10) / 10, y: Math.round(position.y * 10) / 10, z: Math.round(position.z * 10) / 10 },
      health: bot.health,
      food: bot.food,
      dimension: bot.game.dimension,
      timeOfDay: bot.time.timeOfDay,
      inventory: bot.inventory.items().map((item) => ({ name: item.displayName, itemId: `minecraft:${item.name}`, count: item.count, slot: item.slot, ...(typeof item.durabilityUsed === 'number' ? { durability: item.durabilityUsed } : {}) })),
      nearbyPlayers
    }
  }

  async chat(message: string): Promise<void> {
    const bot = this.#requireBot()
    const sanitized = message.replace(/[\r\n]+/gu, ' ').trim().slice(0, 240)
    if (sanitized) bot.chat(sanitized)
  }

  async execute(action: AgentAction): Promise<{ ok: boolean; detail: string }> {
    const policy = this.#policy.authorize(action)
    if (!policy.allowed) return { ok: false, detail: policy.reason }
    const bot = this.#requireBot()
    switch (action.type) {
      case 'none': return { ok: true, detail: '无需游戏动作' }
      case 'stop':
        bot.pathfinder.stop()
        bot.clearControlStates()
        return { ok: true, detail: '已停止当前移动' }
      case 'follow_player': {
        const entity = bot.players[action.target]?.entity
        if (!entity) return { ok: false, detail: `附近找不到玩家 ${action.target}` }
        bot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true)
        return { ok: true, detail: `正在跟随 ${action.target}` }
      }
      case 'come_to_player': {
        const entity = bot.players[action.target]?.entity
        if (!entity) return { ok: false, detail: `附近找不到玩家 ${action.target}` }
        const { x, y, z } = entity.position
        bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), 2))
        return { ok: true, detail: `正在前往 ${action.target}` }
      }
      case 'look_at_player': {
        const entity = bot.players[action.target]?.entity
        if (!entity) return { ok: false, detail: `附近找不到玩家 ${action.target}` }
        await bot.lookAt(entity.position.offset(0, entity.height ?? 1.6, 0), true)
        return { ok: true, detail: `已看向 ${action.target}` }
      }
      case 'wander': {
        const base = bot.entity.position
        const angle = Math.random() * Math.PI * 2
        const targetX = Math.floor(base.x + Math.cos(angle) * action.radius)
        const targetZ = Math.floor(base.z + Math.sin(angle) * action.radius)
        bot.pathfinder.setGoal(new goals.GoalNear(targetX, Math.floor(base.y), targetZ, 1))
        return { ok: true, detail: '开始小范围安全闲逛' }
      }
      case 'explore_frontier': {
        const base = bot.entity.position
        const angle = Math.random() * Math.PI * 2
        bot.pathfinder.setGoal(new goals.GoalNear(
          Math.floor(base.x + Math.cos(angle) * action.radius),
          Math.floor(base.y),
          Math.floor(base.z + Math.sin(angle) * action.radius),
          2
        ))
        return { ok: true, detail: `开始寻找 ${action.purpose}` }
      }
      case 'return_to_zone':
        return { ok: false, detail: 'Mineflayer 兼容适配器不掌握 Fabric 管理员批准区域；请使用 Fabric 26.2 桥接客户端。' }
      case 'attack_player': {
        const entity = bot.players[action.target]?.entity
        if (!entity) return { ok: false, detail: `附近找不到攻击者 ${action.target}` }
        await bot.attack(entity)
        return { ok: true, detail: `已对 ${action.target} 执行一次自卫攻击` }
      }
      case 'break_block': return { ok: false, detail: '破坏性方块执行器尚未启用' }
      case 'open_container': return { ok: false, detail: '容器执行器尚未启用' }
      case 'eat_best_food':
      case 'equip_best':
      case 'attack_hostile':
      case 'hunt_entity':
      case 'collect_own_drops':
      case 'gather_resource':
      case 'craft_item':
      case 'place_block':
      case 'smelt_item':
      case 'trade_villager':
      case 'enchant_item':
      case 'sleep_in_bed':
      case 'excavate_tunnel':
      case 'travel_to_dimension':
      case 'build_nether_portal':
      case 'drop_item':
      case 'use_item':
      case 'seek_shelter':
      case 'build_shelter':
      case 'wait_safe':
      case 'prepare_for':
        return { ok: false, detail: `Mineflayer 兼容适配器尚不支持 ${action.type}；请使用 Fabric 26.2 桥接客户端。` }
    }
  }

  #wireEvents(bot: Bot): void {
    bot.on('login', () => this.#logger.info('Minecraft 协议登录完成', { username: bot.username, server: this.#config.server.host, version: bot.version }))
    bot.on('spawn', () => {
      this.#logger.info('Bot 已进入世界', this.snapshot())
      bot.pathfinder.setMovements(new Movements(bot))
      this.#easyAuth.onSpawn(bot)
      this.#proactiveTimer = setInterval(() => {
        if (this.#proactiveHandler && this.#easyAuth.authenticated) void this.#proactiveHandler(this.snapshot()).catch((error) => this.#logger.error('空闲任务失败', error))
      }, 15000)
      this.#proactiveTimer.unref()
    })
    bot.on('messagestr', (message) => {
      this.#easyAuth.onSystemMessage(bot, message)
      this.#logger.debug('服务器消息', { message })
    })
    bot.on('chat', (username, message) => {
      if (username === bot.username || !this.#messageHandler) return
      const identity: PlayerIdentity = { name: username, ...(bot.players[username]?.uuid ? { uuid: bot.players[username]!.uuid } : {}) }
      const addressed = this.#addressing.decide(identity, message, this.snapshot())
      if (!addressed.addressed) {
        void this.#memory.recordPlayerMessage(identity, this.#secrets.sanitizeForPersistence(message)).catch((error) => this.#logger.error('记录旁听聊天失败', error))
        return
      }
      void this.#messageHandler(identity, addressed.cleaned || message, this.snapshot())
        .then(() => this.#addressing.noteBotReply(identity))
        .catch((error) => this.#logger.error('玩家消息处理器失败', error))
    })
    bot.on('entityHurt', (entity, source) => {
      if (entity !== bot.entity || source.type !== 'player' || !source.username) return
      this.#policy.noteAttack(source.username)
      void this.#memory.recordGameEvent(`${source.username} 攻击了 Bot`, { attacker: source.username, health: bot.health }).catch((error) => this.#logger.error('记录受击事件失败', error))
      void this.execute({ type: 'attack_player', target: source.username }).catch((error) => this.#logger.warn('自动自卫动作失败', error))
    })
    bot.on('kicked', (reason) => this.#logger.warn('Bot 被服务器踢出', { reason }))
    bot.on('error', (error) => this.#logger.error('Minecraft 客户端错误', error))
    bot.on('end', (reason) => {
      if (this.#proactiveTimer) clearInterval(this.#proactiveTimer)
      this.#proactiveTimer = undefined
      this.#logger.warn('Minecraft 连接结束', { reason })
      this.#endResolve?.(reason)
      this.#endResolve = undefined
    })
  }

  #requireBot(): Bot {
    if (!this.#bot?.entity) throw new Error('Bot 尚未进入世界')
    return this.#bot
  }
}
