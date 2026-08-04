import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { BehaviorRules, BotConfig, Persona, PromptTemplates, ReasoningEffort } from './types.js'
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
  if (path.resolve(config.storage.memoryFile) === path.resolve(config.storage.experienceFile)) {
    throw new Error('记忆文件与经验文件必须分开')
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
    const zone = config.autonomy.developmentZone
    if (zone !== undefined) {
      if (typeof zone.enabled !== 'boolean') throw new Error('autonomy.developmentZone.enabled 必须是布尔值')
      requireString(zone.dimension, 'autonomy.developmentZone.dimension')
      for (const coordinate of ['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'] as const) {
        if (!Number.isInteger(zone[coordinate]) || Math.abs(zone[coordinate]) > 30_000_000) throw new Error(`autonomy.developmentZone.${coordinate} 必须是有效方块坐标整数`)
      }
      if (zone.minX > zone.maxX || zone.minY > zone.maxY || zone.minZ > zone.maxZ) throw new Error('autonomy.developmentZone 最小坐标不能大于最大坐标')
      if (zone.maxX - zone.minX > 256 || zone.maxY - zone.minY > 128 || zone.maxZ - zone.minZ > 256) throw new Error('autonomy.developmentZone 范围过大；单边最大 256 格，高度最大 128 格')
    }
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
