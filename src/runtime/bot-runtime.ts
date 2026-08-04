import { setTimeout as delay } from 'node:timers/promises'
import type { LoadedProjectConfig } from '../config/load-config.js'
import { Logger } from '../core/logger.js'
import { ExperienceStore } from '../experience/experience-store.js'
import { createLlmProvider } from '../llm/provider-factory.js'
import { MemoryStore } from '../memory/memory-store.js'
import { MinecraftClient } from '../minecraft/minecraft-client.js'
import { FabricBridgeClient } from '../minecraft/fabric-bridge-client.js'
import { PolicyEngine } from '../policy/policy-engine.js'
import { AgentController } from '../agent/agent-controller.js'
import { RuntimeStatusStore } from './status-store.js'
import { TaskStore } from '../tasks/task-store.js'
import { SecretGuard } from '../security/secret-guard.js'
import path from 'node:path'

export class BotRuntime {
  readonly #loaded: LoadedProjectConfig
  readonly #logger: Logger
  #client?: MinecraftClient | FabricBridgeClient
  #stopping = false

  constructor(loaded: LoadedProjectConfig) {
    this.#loaded = loaded
    this.#logger = new Logger({ ...loaded.config.logging, secrets: [loaded.apiKey, loaded.easyAuthPassword ?? '', loaded.config.server.host] })
  }

  async run(): Promise<void> {
    const { config, persona, prompts, rules, apiKey, easyAuthPassword } = this.#loaded
    const memory = new MemoryStore(config.storage.memoryFile, persona.name, config.storage.maxEvents)
    const experience = new ExperienceStore(config.storage.experienceFile)
    const tasks = new TaskStore(config.storage.taskFile ?? 'data/tasks.json', config.autonomy?.ownerName ? { ownerName: config.autonomy.ownerName } : {})
    const secrets = new SecretGuard([apiKey, easyAuthPassword, config.server.host, path.resolve('.')])
    const status = new RuntimeStatusStore()
    await Promise.all([memory.load(), experience.load(), tasks.load(), status.load()])
    const serverLabel = `${config.server.host}:${config.server.port}`
    await status.report('starting', config.server.adapter, serverLabel, { connected: false, inventory: [], nearbyPlayers: [] })
    const provider = createLlmProvider(config.model, apiKey, this.#logger)
    while (!this.#stopping) {
      const policy = new PolicyEngine(rules)
      const client = config.server.adapter === 'fabric_bridge'
        ? new FabricBridgeClient({ config, persona, logger: this.#logger, memory, policy, secrets, statusHandler: (phase, world) => status.report(phase, config.server.adapter, serverLabel, world) })
        : new MinecraftClient({ config, persona, logger: this.#logger, memory, policy, secrets, ...(easyAuthPassword ? { easyAuthPassword } : {}) })
      this.#client = client
      await status.report('waiting_for_client', config.server.adapter, serverLabel, client.snapshot())
      const controller = new AgentController({ config, persona, prompts, provider, memory, experience, policy, executor: client, logger: this.#logger, tasks, secrets })
      await controller.initialize()
      client.setMessageHandler((identity, message, world) => controller.handlePlayerMessage(identity, message, world))
      client.setProactiveHandler((world) => controller.proactiveTick(world))
      try {
        await client.connect()
        this.#logger.info('运行时已就绪，后台等待玩家消息')
        await client.waitForEnd()
      } catch (error) {
        this.#logger.error('连接尝试失败', error)
      }
      await client.close('reconnect')
      if (!this.#stopping) await delay(config.server.reconnectDelayMs)
    }
    await status.report('stopped', config.server.adapter, serverLabel, { connected: false, inventory: [], nearbyPlayers: [] })
    await this.#logger.flush()
  }

  async stop(): Promise<void> {
    this.#stopping = true
    await this.#client?.close('shutdown')
    await this.#logger.flush()
  }
}
