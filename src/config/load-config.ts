import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { agentWorkspaceConfig, type BehaviorRules, type BotConfig, type Persona, type PromptTemplates, type ReasoningEffort } from './types.js'
import { parseJsonDocument } from '../core/json.js'

const VALID_EFFORTS = new Set<ReasoningEffort>(['none', 'low', 'medium', 'high', 'xhigh', 'max'])

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function readJson<T>(file: string): Promise<T> {
  return parseJsonDocument<T>(await readFile(file, 'utf8'))
}

export async function loadEnvFile(file = path.resolve('.env')): Promise<void> {
  if (!(await exists(file))) return
  const content = await readFile(file, 'utf8')
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

function requireString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} 必须是非空字符串`)
}

function requirePositiveInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${name} 必须是正整数`)
}

export function validateConfig(config: BotConfig): void {
  if (!['fabric_bridge', 'mineflayer'].includes(config.server?.adapter)) throw new Error('server.adapter 只能是 fabric_bridge 或 mineflayer')
  if (!['direct', 'lan'].includes(config.server?.connectionMode)) throw new Error('server.connectionMode 只能是 direct 或 lan')
  requireString(config.server?.host, 'server.host')
  requirePositiveInteger(config.server?.port, 'server.port')
  requirePositiveInteger(config.server?.lanDiscoveryTimeoutMs, 'server.lanDiscoveryTimeoutMs')
  requireString(config.server?.version, 'server.version')
  requireString(config.server?.username, 'server.username')
  if (!/^[A-Za-z0-9_]{3,16}$/u.test(config.server.username)) {
    throw new Error('server.username 必须是 3-16 位英文字母、数字或下划线；EasyAuth 不接受空格、连字符或中文')
  }
  if (config.server.autoRespawn !== undefined && typeof config.server.autoRespawn !== 'boolean') throw new Error('server.autoRespawn 必须是布尔值')
  if (config.server.respawnDelayMs !== undefined && (!Number.isInteger(config.server.respawnDelayMs) || config.server.respawnDelayMs < 0 || config.server.respawnDelayMs > 60000)) {
    throw new Error('server.respawnDelayMs 必须是 0-60000 的整数')
  }
  requireString(config.server?.bridgeHost, 'server.bridgeHost')
  requirePositiveInteger(config.server?.bridgePort, 'server.bridgePort')
  requirePositiveInteger(config.server?.actionTimeoutMs, 'server.actionTimeoutMs')
  if (!['offline', 'microsoft'].includes(config.server.auth)) throw new Error('server.auth 只能是 offline 或 microsoft')
  requireString(config.model?.provider, 'model.provider')
  if (!['deepseek', 'volcengine', 'openai'].includes(config.model.provider)) throw new Error('model.provider 只能是 deepseek、volcengine 或 openai')
  requireString(config.model?.model, 'model.model')
  requireString(config.model?.apiKeyEnv, 'model.apiKeyEnv')
  if (!['DEEPSEEK_API_KEY', 'ARK_API_KEY', 'OPENAI_API_KEY'].includes(config.model.apiKeyEnv)) throw new Error('model.apiKeyEnv 只能使用受支持的模型密钥环境变量')
  requireString(config.model?.baseUrl, 'model.baseUrl')
  const modelUrl = new URL(config.model.baseUrl)
  if (modelUrl.protocol !== 'https:' && !['127.0.0.1', 'localhost', '::1'].includes(modelUrl.hostname)) throw new Error('model.baseUrl 必须使用 HTTPS；仅本机测试地址可使用 HTTP')
  if (!VALID_EFFORTS.has(config.model.reasoningEffort)) throw new Error('model.reasoningEffort 无效')
  if (!Number.isInteger(config.model.timeoutMs) || config.model.timeoutMs < 1000 || config.model.timeoutMs > 600_000) {
    throw new Error('model.timeoutMs 必须是 1000-600000 的整数')
  }
  if (config.model.maxOutputTokens !== undefined && (!Number.isInteger(config.model.maxOutputTokens) || config.model.maxOutputTokens < 128 || config.model.maxOutputTokens > 131_072)) {
    throw new Error('model.maxOutputTokens 必须是 128-131072 的整数')
  }
  requireString(config.storage?.memoryFile, 'storage.memoryFile')
  requireString(config.storage?.experienceFile, 'storage.experienceFile')
  if (config.storage.taskFile !== undefined) requireString(config.storage.taskFile, 'storage.taskFile')
  if (config.storage.autonomyFile !== undefined) requireString(config.storage.autonomyFile, 'storage.autonomyFile')
  if (config.storage.progressionFile !== undefined) requireString(config.storage.progressionFile, 'storage.progressionFile')
  if (config.storage.ownedBlocksFile !== undefined) requireString(config.storage.ownedBlocksFile, 'storage.ownedBlocksFile')
  if (path.resolve(config.storage.memoryFile) === path.resolve(config.storage.experienceFile)) {
    throw new Error('记忆文件与经验文件必须分开')
  }
  const workspace = agentWorkspaceConfig(config)
  requireString(workspace.promptDirectory, 'agentWorkspace.promptDirectory')
  requireString(workspace.playerProfilesDirectory, 'agentWorkspace.playerProfilesDirectory')
  if (path.resolve(workspace.promptDirectory) === path.resolve(workspace.playerProfilesDirectory)) throw new Error('系统提示词目录与玩家画像目录必须分开')
  if (!Number.isInteger(workspace.contextBudgetChars) || workspace.contextBudgetChars < 8_000 || workspace.contextBudgetChars > 500_000) throw new Error('agentWorkspace.contextBudgetChars 必须是 8000-500000 的整数')
  if (!Number.isFinite(workspace.compressionTriggerRatio) || workspace.compressionTriggerRatio < 0.5 || workspace.compressionTriggerRatio > 0.95) throw new Error('agentWorkspace.compressionTriggerRatio 必须在 0.5-0.95 之间')
  if (!Number.isInteger(workspace.retainRecentEvents) || workspace.retainRecentEvents < 4 || workspace.retainRecentEvents > 64) throw new Error('agentWorkspace.retainRecentEvents 必须是 4-64 的整数')
  const improvement = workspace.selfImprovement
  for (const key of ['enabled', 'allowPromptEdits', 'allowBehaviorPatches'] as const) {
    if (typeof improvement[key] !== 'boolean') throw new Error(`agentWorkspace.selfImprovement.${key} 必须是布尔值`)
  }
  if (!Number.isInteger(improvement.minimumRepeatedFailures) || improvement.minimumRepeatedFailures < 2 || improvement.minimumRepeatedFailures > 10) throw new Error('minimumRepeatedFailures 必须是 2-10 的整数')
  if (!['baidu', 'searxng', 'disabled'].includes(improvement.researchProvider)) throw new Error('researchProvider 只能是 baidu、searxng 或 disabled')
  if (!Number.isInteger(improvement.researchTimeoutMs) || improvement.researchTimeoutMs < 1000 || improvement.researchTimeoutMs > 60_000) throw new Error('researchTimeoutMs 必须是 1000-60000 的整数')
  if (improvement.researchProvider !== 'disabled') {
    requireString(improvement.researchEndpoint, 'agentWorkspace.selfImprovement.researchEndpoint')
    const researchUrl = new URL(improvement.researchEndpoint)
    const localOrLan = ['localhost', '127.0.0.1', '::1'].includes(researchUrl.hostname)
      || /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(researchUrl.hostname)
    if (researchUrl.protocol !== 'https:' && !localOrLan) throw new Error('研究端点必须使用 HTTPS；本机或局域网 SearXNG 可使用 HTTP')
  }
  if (typeof config.easyAuth?.registerIfNeeded !== 'boolean') throw new Error('easyAuth.registerIfNeeded 必须是布尔值')
  if (config.autonomy !== undefined) {
    requireString(config.autonomy.ownerName, 'autonomy.ownerName')
    if (!/^[A-Za-z0-9_]{3,16}$/u.test(config.autonomy.ownerName)) throw new Error('autonomy.ownerName 必须是有效的 Minecraft 玩家名')
    for (const [name, value, minimum, maximum] of [
      ['commandArbitrationMs', config.autonomy.commandArbitrationMs, 0, 5000],
      ['directAddressDistance', config.autonomy.directAddressDistance, 1, 64],
      ['conversationWindowMs', config.autonomy.conversationWindowMs, 1000, 600_000],
      ['lowHealthThreshold', config.autonomy.lowHealthThreshold, 1, 20],
      ['criticalHealthThreshold', config.autonomy.criticalHealthThreshold, 1, 20],
      ['eatBelowFood', config.autonomy.eatBelowFood, 1, 20],
      ['hostileScanRadius', config.autonomy.hostileScanRadius, 1, 32],
      ['wildernessMinPlayerDistance', config.autonomy.wildernessMinPlayerDistance, 16, 512]
    ] as const) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`autonomy.${name} 必须在 ${minimum}-${maximum} 之间`)
    }
    if (config.autonomy.criticalHealthThreshold > config.autonomy.lowHealthThreshold) throw new Error('autonomy.criticalHealthThreshold 不能高于 lowHealthThreshold')
    for (const name of ['enabled', 'contextualAddressing', 'safeIdleEnabled', 'autoGather', 'autoCraft', 'autoBuildShelter'] as const) {
      if (typeof config.autonomy[name] !== 'boolean') throw new Error(`autonomy.${name} 必须是布尔值`)
    }
    for (const name of ['autoHunt', 'autoSmelt', 'autoMine', 'autoTrade', 'autoEnchant', 'autoDimensionTravel', 'autoSleep', 'protectOwner', 'allowVerifiedWilderness'] as const) {
      if (config.autonomy[name] !== undefined && typeof config.autonomy[name] !== 'boolean') throw new Error(`autonomy.${name} 必须是布尔值`)
    }
    if (config.autonomy.longTermGoal !== undefined && config.autonomy.longTermGoal !== 'reach_end') throw new Error('autonomy.longTermGoal 当前只能是 reach_end')
    // developmentZone is deliberately not validated. It is a removed legacy field,
    // ignored by autonomyConfig(), and must never block startup or grant permission.
  }
  requireString(config.promptsFile, 'promptsFile')
}

export interface LoadedProjectConfig {
  config: BotConfig
  persona: Persona
  prompts: PromptTemplates
  rules: BehaviorRules
  apiKey: string
  easyAuthPassword?: string
}

export async function loadProjectConfig(options: { allowExample?: boolean } = {}): Promise<LoadedProjectConfig> {
  await loadEnvFile()
  const configPath = path.resolve(process.env.BOT_CONFIG ?? 'config/bot.json')
  const effectiveConfigPath = await exists(configPath)
    ? configPath
    : options.allowExample
      ? path.resolve('config/bot.example.json')
      : configPath

  if (!(await exists(effectiveConfigPath))) {
    throw new Error('缺少 config/bot.json。请复制 config/bot.example.json 后填写配置。')
  }

  const config = await readJson<BotConfig>(effectiveConfigPath)
  validateConfig(config)
  const personaPath = path.resolve(config.personaFile)
  const effectivePersonaPath = await exists(personaPath) ? personaPath : path.resolve('config/persona.example.json')
  const persona = await readJson<Persona>(effectivePersonaPath)
  const promptsPath = path.resolve(config.promptsFile)
  const effectivePromptsPath = await exists(promptsPath) ? promptsPath : path.resolve('config/prompts.example.json')
  const prompts = await readJson<PromptTemplates>(effectivePromptsPath)
  const rules = await readJson<BehaviorRules>(path.resolve(config.policyFile))
  requireString(persona.name, 'persona.name')

  const apiKey = process.env[config.model.apiKeyEnv]?.trim() ?? ''
  const password = config.easyAuth.enabled ? process.env[config.easyAuth.passwordEnv]?.trim() : undefined
  return {
    config,
    persona,
    prompts,
    rules,
    apiKey,
    ...(password ? { easyAuthPassword: password } : {})
  }
}
