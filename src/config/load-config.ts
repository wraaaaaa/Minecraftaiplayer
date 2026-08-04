import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { BehaviorRules, BotConfig, Persona, PromptTemplates, ReasoningEffort } from './types.js'

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
  return JSON.parse(await readFile(file, 'utf8')) as T
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
  requireString(config.server?.bridgeHost, 'server.bridgeHost')
  requirePositiveInteger(config.server?.bridgePort, 'server.bridgePort')
  requirePositiveInteger(config.server?.actionTimeoutMs, 'server.actionTimeoutMs')
  if (!['offline', 'microsoft'].includes(config.server.auth)) throw new Error('server.auth 只能是 offline 或 microsoft')
  requireString(config.model?.provider, 'model.provider')
  requireString(config.model?.model, 'model.model')
  requireString(config.model?.apiKeyEnv, 'model.apiKeyEnv')
  requireString(config.model?.baseUrl, 'model.baseUrl')
  if (!VALID_EFFORTS.has(config.model.reasoningEffort)) throw new Error('model.reasoningEffort 无效')
  requireString(config.storage?.memoryFile, 'storage.memoryFile')
  requireString(config.storage?.experienceFile, 'storage.experienceFile')
  if (path.resolve(config.storage.memoryFile) === path.resolve(config.storage.experienceFile)) {
    throw new Error('记忆文件与经验文件必须分开')
  }
  if (typeof config.easyAuth?.registerIfNeeded !== 'boolean') throw new Error('easyAuth.registerIfNeeded 必须是布尔值')
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
