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

export class BotRuntime {
  readonly #loaded: LoadedProjectConfig
  readonly #logger: Logger
  #client?: MinecraftClient | FabricBridgeClient
  #stopping = false

  constructor(loaded: LoadedProjectConfig) {
    this.#loaded = loaded
    this.#logger = new Logger(loaded.config.logging)
  }

  async run(): Promise<void> {
    const { config, persona, rules, apiKey, easyAuthPassword } = this.#loaded
    const memory = new MemoryStore(config.storage.memoryFile, persona.name, config.storage.maxEvents)
    const experience = new ExperienceStore(config.storage.experienceFile)
    await Promise.all([memory.load(), experience.load()])
    const provider = createLlmProvider(config.model, apiKey, this.#logger)
    while (!this.#stopping) {
      const policy = new PolicyEngine(rules)
      const client = config.server.adapter === 'fabric_bridge'
        ? new FabricBridgeClient({ config, persona, logger: this.#logger, memory, policy })
        : new MinecraftClient({ config, persona, logger: this.#logger, memory, policy, ...(easyAuthPassword ? { easyAuthPassword } : {}) })
      this.#client = client
      const controller = new AgentController({ config, persona, provider, memory, experience, policy, executor: client, logger: this.#logger })
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
    await this.#logger.flush()
  }

  async stop(): Promise<void> {
    this.#stopping = true
    await this.#client?.close('shutdown')
    await this.#logger.flush()
  }
}
