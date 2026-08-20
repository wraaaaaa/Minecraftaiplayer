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
import { DiagnosticStore } from '../diagnostics/diagnostic-store.js'
import { SecretGuard } from '../security/secret-guard.js'
import path from 'node:path'
import { ProgressionStore } from '../progression/progression-store.js'
import { agentWorkspaceConfig, speechConfig } from '../config/types.js'
import { PromptWorkspace } from '../prompts/prompt-workspace.js'
import { ContextCompressor } from '../memory/context-compressor.js'
import { SelfImprovementManager } from '../self-improvement/self-improvement-manager.js'
import { AdminCommandInbox } from '../admin/admin-command-inbox.js'

export class BotRuntime {
  readonly #loaded: LoadedProjectConfig
  readonly #logger: Logger
  #client?: MinecraftClient | FabricBridgeClient
  #stopping = false

  constructor(loaded: LoadedProjectConfig) {
    this.#loaded = loaded
    const speech = speechConfig(loaded.config)
    this.#logger = new Logger({ ...loaded.config.logging, secrets: [loaded.apiKey, loaded.easyAuthPassword ?? '', process.env[speech.apiKeyEnv] ?? '', process.env[speech.volcengineAppIdEnv] ?? '', loaded.config.server.host] })
  }

  async run(): Promise<void> {
    const { config, persona, prompts, rules, apiKey, easyAuthPassword } = this.#loaded
    const memory = new MemoryStore(config.storage.memoryFile, persona.name, config.storage.maxEvents)
    const experience = new ExperienceStore(config.storage.experienceFile)
    const tasks = new TaskStore(config.storage.taskFile ?? 'data/tasks.json', config.autonomy?.ownerName ? { ownerName: config.autonomy.ownerName } : {})
    const diagnostics = new DiagnosticStore('data/diagnostics.json')
    const progression = new ProgressionStore(config.storage.progressionFile ?? 'data/progression.json')
    const speech = speechConfig(config)
    const secrets = new SecretGuard([apiKey, easyAuthPassword, process.env[speech.apiKeyEnv], process.env[speech.volcengineAppIdEnv], config.server.host, path.resolve('.')])
    const workspaceConfig = agentWorkspaceConfig(config)
    const promptWorkspace = new PromptWorkspace({
      promptDirectory: workspaceConfig.promptDirectory,
      playerProfilesDirectory: workspaceConfig.playerProfilesDirectory
    })
    const status = new RuntimeStatusStore()
    const adminInbox = new AdminCommandInbox('data/admin-inbox')
    const provider = createLlmProvider(config.model, apiKey, this.#logger)
    const contextCompressor = new ContextCompressor({ config: workspaceConfig, provider, memory, workspace: promptWorkspace, secrets })
    const selfImprovement = new SelfImprovementManager({ config: workspaceConfig.selfImprovement, provider, workspace: promptWorkspace, secrets })
    const existingMemory = await memory.load()
    await Promise.all([experience.load(), tasks.load(), diagnostics.load(), progression.load(), status.load(), promptWorkspace.initialize(), selfImprovement.initialize(), adminInbox.initialize()])
    await Promise.all(Object.values(existingMemory.players).map(player => promptWorkspace.ensurePlayerProfile(
      { name: player.currentName, ...(player.uuid ? { uuid: player.uuid } : {}) },
      player
    )))
    const serverLabel = `${config.server.host}:${config.server.port}`
    await status.report('starting', config.server.adapter, serverLabel, { connected: false, inventory: [], nearbyPlayers: [] })
    let reconnectAttempts = 0
    while (!this.#stopping) {
      const policy = new PolicyEngine(rules)
      const client = config.server.adapter === 'fabric_bridge'
        ? new FabricBridgeClient({ config, persona, logger: this.#logger, memory, policy, secrets, statusHandler: (phase, world) => status.report(phase, config.server.adapter, serverLabel, world) })
        : new MinecraftClient({ config, persona, logger: this.#logger, memory, policy, secrets, ...(easyAuthPassword ? { easyAuthPassword } : {}) })
      this.#client = client
      client.setAddressAliasesResolver(identity => promptWorkspace.botAliases(identity))
      await status.report('waiting_for_client', config.server.adapter, serverLabel, client.snapshot())
      const controller = new AgentController({ config, persona, prompts, provider, memory, experience, policy, executor: client, logger: this.#logger, tasks, secrets, diagnostics, progression, promptWorkspace, contextCompressor, selfImprovement })
      await controller.initialize()
      client.setMessageHandler((identity, message, world) => controller.handlePlayerMessage(identity, message, world))
      client.setProactiveHandler((world) => controller.proactiveTick(world))
      try {
        await client.connect()
        this.#logger.info('运行时已就绪，后台等待玩家消息')
        let adminPolling = false
        const pollAdmin = async (): Promise<void> => {
          if (adminPolling || this.#stopping) return
          adminPolling = true
          try {
            while (true) {
              const command = await adminInbox.claimNext()
              if (!command) break
              try {
                await controller.handleAdminMessage(command.message, client.snapshot())
                await adminInbox.finish(command, true, 'accepted_and_processed')
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error)
                await adminInbox.finish(command, false, detail)
                this.#logger.error('WebUI 管理指令执行失败', { commandId: command.id, error: detail })
              }
            }
          } finally { adminPolling = false }
        }
        const adminTimer = setInterval(() => { void pollAdmin() }, 250)
        adminTimer.unref()
        void pollAdmin()
        try { await client.waitForEnd() } finally { clearInterval(adminTimer) }
      } catch (error) {
        this.#logger.error('连接尝试失败', error)
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EADDRINUSE') {
          this.#logger.error('桥接端口被其他进程占用，停止重连', { port: config.server.bridgePort })
          break
        }
        reconnectAttempts += 1
        if (reconnectAttempts > 30) {
          this.#logger.error('桥接重连次数达到上限，停止重连', { attempts: reconnectAttempts })
          break
        }
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
