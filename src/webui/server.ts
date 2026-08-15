import { execFile } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { access, copyFile, mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { loadProjectConfig, validateConfig } from '../config/load-config.js'
import { agentWorkspaceConfig, DEFAULT_AGENT_WORKSPACE_CONFIG, DEFAULT_AUTONOMY_CONFIG, DEFAULT_SPEECH_CONFIG, type BehaviorRules, type BotConfig, type ModsConfig, type Persona, type PromptTemplates, type SkinConfig } from '../config/types.js'
import { Logger } from '../core/logger.js'
import { parseJsonDocument } from '../core/json.js'
import { createLlmProvider } from '../llm/provider-factory.js'
import type { RuntimeStatus } from '../runtime/status-store.js'
import { discoverLanServers } from '../network/lan-discovery.js'
import { decodePngDataUrl, validateMinecraftSkin } from '../skin/png.js'
import type { MemoryDocument } from '../memory/memory-store.js'
import type { ExperienceDocument } from '../experience/experience-store.js'
import type { TaskDocument } from '../tasks/task-store.js'
import type { DiagnosticDocument } from '../diagnostics/diagnostic-store.js'
import type { ProgressionDocument } from '../progression/progression-store.js'
import { PROMPT_DOCUMENTS, PromptWorkspace, type PromptDocuments } from '../prompts/prompt-workspace.js'
import { AdminCommandInbox } from '../admin/admin-command-inbox.js'
import { mergeManagedEnv } from './env-file.js'
import { redactForWebUi } from './redaction.js'

const execFileAsync = promisify(execFile)
const projectRoot = path.resolve(process.cwd())
const publicRoot = path.join(projectRoot, 'public', 'webui')
const port = Number.parseInt(process.env.MCAI_WEBUI_PORT ?? '3210', 10)
const host = '127.0.0.1'
const MAX_BODY_BYTES = 2 * 1024 * 1024
const secretKeys = ['MINECRAFT_LOGIN_PASSWORD', 'DEEPSEEK_API_KEY', 'ARK_API_KEY', 'OPENAI_API_KEY', 'MIMO_API_KEY', 'VOLCENGINE_TTS_APP_ID', 'VOLCENGINE_TTS_ACCESS_TOKEN', 'CUSTOM_TTS_API_KEY'] as const
const adminInbox = new AdminCommandInbox(path.join(projectRoot, 'data', 'admin-inbox'))

type WebUiBotConfig = BotConfig

const files = {
  config: path.join(projectRoot, 'config', 'bot.json'),
  configExample: path.join(projectRoot, 'config', 'bot.example.json'),
  persona: path.join(projectRoot, 'config', 'persona.json'),
  personaExample: path.join(projectRoot, 'config', 'persona.example.json'),
  prompts: path.join(projectRoot, 'config', 'prompts.json'),
  promptsExample: path.join(projectRoot, 'config', 'prompts.example.json'),
  skin: path.join(projectRoot, 'config', 'skin.json'),
  skinExample: path.join(projectRoot, 'config', 'skin.example.json'),
  rules: path.join(projectRoot, 'config', 'behavior-rules.json'),
  mods: path.join(projectRoot, 'config', 'mods.json'),
  modsExample: path.join(projectRoot, 'config', 'mods.example.json'),
  env: path.join(projectRoot, '.env'),
  modManifest: path.join(projectRoot, '.runtime', 'minecraft', 'managed-mods.json'),
  botPid: path.join(projectRoot, 'data', 'bot.pid.json'),
  clientPid: path.join(projectRoot, 'data', 'minecraft-client.pid.json'),
  runtimeStatus: path.join(projectRoot, 'data', 'runtime-status.json'),
  memory: path.join(projectRoot, 'data', 'memory.json'),
  experience: path.join(projectRoot, 'data', 'experience.json'),
  diagnostics: path.join(projectRoot, 'data', 'diagnostics.json'),
  skinVendor: path.join(projectRoot, 'vendor', 'custom-skin-loader', 'CustomSkinLoader_Universal-15.0.1.jar'),
  botLog: path.join(projectRoot, 'logs', 'bot.log'),
  gameLog: path.join(projectRoot, '.runtime', 'minecraft', 'logs', 'latest.log')
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true } catch { return false }
}

async function readJson<T>(primary: string, fallback?: string): Promise<T> {
  const selected = await exists(primary) ? primary : fallback
  if (!selected) throw new Error(`文件不存在：${primary}`)
  return parseJsonDocument<T>(await readFile(selected, 'utf8'))
}

async function readRuntimeJson<T>(primary: string): Promise<T> {
  try { return await readJson<T>(primary) }
  catch (primaryError) {
    const backup = `${primary}.bak`
    if (await exists(backup)) return readJson<T>(backup)
    throw primaryError
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('请求内容超过 2 MiB 限制')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 必须是对象`)
  return value as Record<string, unknown>
}

function validatePersona(value: unknown): asserts value is Persona {
  const candidate = object(value, 'persona')
  for (const key of ['name', 'description', 'speakingStyle'] as const) {
    if (typeof candidate[key] !== 'string' || !candidate[key].trim()) throw new Error(`persona.${key} 必须是非空字符串`)
  }
  for (const key of ['goals', 'boundaries'] as const) {
    if (!Array.isArray(candidate[key]) || !(candidate[key] as unknown[]).every(item => typeof item === 'string')) throw new Error(`persona.${key} 必须是字符串数组`)
  }
}

function validateRules(value: unknown): asserts value is BehaviorRules {
  const candidate = object(value, 'rules')
  if (candidate.version !== 1) throw new Error('rules.version 当前必须为 1')
  if (typeof candidate.selfDefenseWindowMs !== 'number' || candidate.selfDefenseWindowMs < 1000) throw new Error('自卫窗口不能小于 1000ms')
  for (const key of ['denyBreakingPlayerProperty', 'denyOpeningPlayerContainers', 'denyTakingPlayerItems', 'wildernessDevelopmentOnly', 'allowSelfDefense', 'stopSelfDefenseWhenThreatEnds', 'allowPlayerOrderedPvp', 'allowDestructiveActionsWhenOwnershipUnknown'] as const) {
    if (typeof candidate[key] !== 'boolean') throw new Error(`rules.${key} 必须是布尔值`)
  }
  const proactiveChat = object(candidate.proactiveChat, 'rules.proactiveChat')
  for (const key of ['enabled', 'avoidSecrets', 'avoidSpam'] as const) {
    if (typeof proactiveChat[key] !== 'boolean') throw new Error(`rules.proactiveChat.${key} 必须是布尔值`)
  }
}

function validateMods(value: unknown): asserts value is ModsConfig {
  const candidate = object(value, 'mods')
  if (typeof candidate.sourceDirectory !== 'string') throw new Error('mods.sourceDirectory 必须是字符串')
  if (typeof candidate.syncOnClientStart !== 'boolean') throw new Error('mods.syncOnClientStart 必须是布尔值')
  if (!Array.isArray(candidate.excludeFilePatterns) || !(candidate.excludeFilePatterns as unknown[]).every(item => typeof item === 'string')) throw new Error('排除规则必须是字符串数组')
  for (const pattern of candidate.excludeFilePatterns as string[]) new RegExp(pattern, 'iu')
}

function validatePrompts(value: unknown): asserts value is PromptTemplates {
  const candidate = object(value, 'prompts')
  for (const key of ['identity', 'actionContract', 'proactiveInstruction'] as const) {
    if (typeof candidate[key] !== 'string' || !candidate[key].trim()) throw new Error(`prompts.${key} 必须是非空字符串`)
  }
  for (const key of ['capabilityRules', 'memoryRules'] as const) {
    if (!Array.isArray(candidate[key]) || !(candidate[key] as unknown[]).every(item => typeof item === 'string' && item.trim())) throw new Error(`prompts.${key} 必须是非空字符串数组`)
  }
}

function validatePromptDocuments(value: unknown): asserts value is PromptDocuments {
  const candidate = object(value, 'agentPrompts')
  for (const name of PROMPT_DOCUMENTS) {
    if (typeof candidate[name] !== 'string' || !candidate[name].trim()) throw new Error(`${name} 必须是非空 Markdown`)
    if ((candidate[name] as string).length > 128_000) throw new Error(`${name} 超过 128000 字符限制`)
  }
}

function validateSkin(value: unknown): asserts value is SkinConfig {
  const candidate = object(value, 'skin')
  if (typeof candidate.enabled !== 'boolean') throw new Error('skin.enabled 必须是布尔值')
  if (!['classic', 'slim'].includes(String(candidate.model))) throw new Error('skin.model 只能是 classic 或 slim')
  if (!['client_pack', 'online_provider', 'microsoft'].includes(String(candidate.visibilityMode))) throw new Error('skin.visibilityMode 无效')
  if (typeof candidate.skinFile !== 'string' || typeof candidate.capeFile !== 'string') throw new Error('皮肤文件路径无效')
  const provider = object(candidate.onlineProvider, 'skin.onlineProvider')
  for (const key of ['name', 'profileName', 'website']) if (typeof provider[key] !== 'string') throw new Error(`skin.onlineProvider.${key} 必须是字符串`)
}

function ensureProjectPaths(config: WebUiBotConfig): void {
  const workspace = agentWorkspaceConfig(config)
  const checks: Array<[string, string]> = [
    [config.personaFile, path.join(projectRoot, 'config')],
    [config.promptsFile, path.join(projectRoot, 'config')],
    [config.policyFile, path.join(projectRoot, 'config')],
    [config.storage.memoryFile, path.join(projectRoot, 'data')],
    [config.storage.experienceFile, path.join(projectRoot, 'data')],
    [config.storage.taskFile ?? 'data/tasks.json', path.join(projectRoot, 'data')],
    [config.storage.autonomyFile ?? 'data/autonomy-state.json', path.join(projectRoot, 'data')],
    [config.storage.progressionFile ?? 'data/progression.json', path.join(projectRoot, 'data')],
    [config.storage.ownedBlocksFile ?? 'data/owned-blocks.json', path.join(projectRoot, 'data')],
    [workspace.promptDirectory, path.join(projectRoot, 'data')],
    [workspace.playerProfilesDirectory, path.join(projectRoot, 'data')],
    [config.model.multimodal?.sensoryDirectory ?? 'data/sensory', path.join(projectRoot, 'data')],
    [config.logging.file, path.join(projectRoot, 'logs')]
  ]
  for (const [configured, allowedRoot] of checks) {
    const resolved = path.resolve(projectRoot, configured)
    if (resolved !== allowedRoot && !resolved.startsWith(`${allowedRoot}${path.sep}`)) throw new Error(`WebUI 不允许把文件写到项目范围外：${configured}`)
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.server.bridgeHost)) throw new Error('Fabric 桥必须绑定本机回环地址')
}

function promptWorkspace(config: WebUiBotConfig): PromptWorkspace {
  const workspace = agentWorkspaceConfig(config)
  return new PromptWorkspace({ promptDirectory: workspace.promptDirectory, playerProfilesDirectory: workspace.playerProfilesDirectory })
}

function ensureSkinPaths(skin: SkinConfig): void {
  for (const [configured, allowedRoot] of [[skin.skinFile, path.join(projectRoot, 'data', 'skins')], [skin.capeFile, path.join(projectRoot, 'data', 'capes')]] as Array<[string, string]>) {
    if (!configured) continue
    const resolved = path.resolve(projectRoot, configured)
    if (resolved !== allowedRoot && !resolved.startsWith(`${allowedRoot}${path.sep}`)) throw new Error(`皮肤或披风文件必须保存在 data 内：${configured}`)
  }
}

async function processStatus(pidFile: string): Promise<{ running: boolean; pid?: number }> {
  try {
    const record = await readJson<{ pid: number; projectRoot?: string }>(pidFile)
    if (!record.projectRoot || path.resolve(record.projectRoot) !== projectRoot) return { running: false }
    process.kill(record.pid, 0)
    return { running: true, pid: record.pid }
  } catch { return { running: false } }
}

async function tail(file: string, lineCount = 30): Promise<string[]> {
  try { return (await readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).slice(-lineCount).map(redactForWebUi) } catch { return [] }
}

async function secretState(): Promise<Record<string, boolean>> {
  const text = await readFile(files.env, 'utf8').catch(() => '')
  return Object.fromEntries(secretKeys.map(key => {
    const match = text.match(new RegExp(`^${key}=(.*)$`, 'mu'))
    return [key, Boolean(process.env[key]?.trim() || match?.[1]?.trim())]
  }))
}

async function snapshot(): Promise<unknown> {
  const storedConfig = await readJson<WebUiBotConfig>(files.config, files.configExample)
  const storedAutonomy = { ...storedConfig.autonomy }
  delete storedAutonomy.developmentZone
  const config: WebUiBotConfig = {
    ...storedConfig,
    speech: { ...DEFAULT_SPEECH_CONFIG, ...storedConfig.speech },
    storage: { ...storedConfig.storage, taskFile: storedConfig.storage.taskFile ?? 'data/tasks.json', autonomyFile: storedConfig.storage.autonomyFile ?? 'data/autonomy-state.json', progressionFile: storedConfig.storage.progressionFile ?? 'data/progression.json', ownedBlocksFile: storedConfig.storage.ownedBlocksFile ?? 'data/owned-blocks.json' },
    agentWorkspace: { ...DEFAULT_AGENT_WORKSPACE_CONFIG, ...storedConfig.agentWorkspace, selfImprovement: { ...DEFAULT_AGENT_WORKSPACE_CONFIG.selfImprovement, ...storedConfig.agentWorkspace?.selfImprovement } },
    autonomy: {
      ...DEFAULT_AUTONOMY_CONFIG,
      ...storedAutonomy
    }
  }
  const workspace = promptWorkspace(config)
  await workspace.initialize()
  const memoryFile = path.resolve(projectRoot, config.storage.memoryFile)
  const experienceFile = path.resolve(projectRoot, config.storage.experienceFile)
  const taskFile = path.resolve(projectRoot, config.storage.taskFile ?? 'data/tasks.json')
  const progressionFile = path.resolve(projectRoot, config.storage.progressionFile ?? 'data/progression.json')
  const [persona, prompts, agentPrompts, playerProfiles, behaviorPatches, skin, rules, mods, manifest, live, memory, experience, tasks, progression, diagnostics, bot, client, secrets, botLogs, gameLogs] = await Promise.all([
    readJson<Persona>(files.persona, files.personaExample),
    readJson<PromptTemplates>(files.prompts, files.promptsExample),
    workspace.readDocuments(),
    workspace.listPlayerProfiles(),
    workspace.readBehaviorPatches(),
    readJson<SkinConfig>(files.skin, files.skinExample),
    readJson<BehaviorRules>(files.rules),
    readJson<ModsConfig>(files.mods, files.modsExample),
    readJson<{ sourceDirectory?: string; syncedAt?: string; compatibilityNotice?: string; files?: Array<{ name: string; size: number; sha256: string; compatibility?: { status: string; note: string } }> }>(files.modManifest).catch(() => ({ files: [] })),
    readRuntimeJson<RuntimeStatus>(files.runtimeStatus).catch(() => null),
    readRuntimeJson<MemoryDocument>(memoryFile).catch(() => null),
    readRuntimeJson<ExperienceDocument>(experienceFile).catch(() => null),
    readRuntimeJson<TaskDocument>(taskFile).catch(() => null),
    readRuntimeJson<ProgressionDocument>(progressionFile).catch(() => null),
    readRuntimeJson<DiagnosticDocument>(files.diagnostics).catch(() => null),
    processStatus(files.botPid), processStatus(files.clientPid), secretState(), tail(files.botLog), tail(files.gameLog)
  ])
  return { config, persona, prompts, agentPrompts, playerProfiles, behaviorPatches, skin: { ...skin, imported: await exists(path.resolve(projectRoot, skin.skinFile)), imageUrl: await exists(path.resolve(projectRoot, skin.skinFile)) ? '/api/skin/image' : null }, rules, mods, manifest, live, memory, experience, tasks, progression, diagnostics, runtime: { bot, client }, secrets, logs: { bot: botLogs, game: gameLogs } }
}

async function centralChatSnapshot(): Promise<unknown> {
  const config = await readJson<WebUiBotConfig>(files.config, files.configExample)
  const memoryFile = path.resolve(projectRoot, config.storage.memoryFile)
  const taskFile = path.resolve(projectRoot, config.storage.taskFile ?? 'data/tasks.json')
  const [memory, tasks, diagnostics] = await Promise.all([
    readRuntimeJson<MemoryDocument>(memoryFile).catch(() => null),
    readRuntimeJson<TaskDocument>(taskFile).catch(() => null),
    readRuntimeJson<DiagnosticDocument>(files.diagnostics).catch(() => null)
  ])
  return { ok: true, memory, tasks, diagnostics }
}

async function runPowerShell(script: string): Promise<string> {
  const result = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(projectRoot, 'scripts', script)], {
    cwd: projectRoot, timeout: 5 * 60_000, windowsHide: true
  })
  return `${result.stdout}${result.stderr}`.trim()
}

async function updateSecrets(value: unknown): Promise<void> {
  const candidate = object(value, 'secrets')
  const existing = await readFile(files.env, 'utf8').catch(() => '')
  for (const key of secretKeys) {
    const supplied = candidate[key]
    if (supplied === undefined || supplied === '') continue
    if (supplied === null) {
      delete process.env[key]
      continue
    }
    if (typeof supplied !== 'string' || /[\r\n]/u.test(supplied)) throw new Error(`${key} 格式无效`)
    process.env[key] = supplied
  }
  const contents = mergeManagedEnv(existing, candidate as Record<string, string | null | undefined>, secretKeys)
  const temporary = `${files.env}.${process.pid}.tmp`
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, files.env)
}

async function importSkin(value: unknown): Promise<{ width: number; height: number; file: string }> {
  const candidate = object(value, 'skinImport')
  const data = decodePngDataUrl(candidate.dataUrl)
  const dimensions = validateMinecraftSkin(data)
  if (!['classic', 'slim'].includes(String(candidate.model))) throw new Error('皮肤模型只能是 classic 或 slim')
  const config = await readJson<BotConfig>(files.config, files.configExample)
  if (!/^[A-Za-z0-9_]{3,16}$/u.test(config.server.username)) throw new Error('Bot 游戏名必须是 3-16 位字母、数字或下划线')
  const relativeSkinFile = `data/skins/${config.server.username}.png`
  const target = path.join(projectRoot, 'data', 'skins', `${config.server.username}.png`)
  const runtimeSkin = path.join(projectRoot, '.runtime', 'minecraft', 'CustomSkinLoader', 'LocalSkin', 'skins', `${config.server.username}.png`)
  const packSkin = path.join(projectRoot, '.runtime', 'skin-pack', 'CustomSkinLoader', 'LocalSkin', 'skins', `${config.server.username}.png`)
  const runtimeMod = path.join(projectRoot, '.runtime', 'minecraft', 'mods', path.basename(files.skinVendor))
  await Promise.all([mkdir(path.dirname(target), { recursive: true }), mkdir(path.dirname(runtimeSkin), { recursive: true }), mkdir(path.dirname(packSkin), { recursive: true }), mkdir(path.dirname(runtimeMod), { recursive: true })])
  await Promise.all([writeFile(target, data), writeFile(runtimeSkin, data), writeFile(packSkin, data), copyFile(files.skinVendor, runtimeMod)])
  const skin = await readJson<SkinConfig>(files.skin, files.skinExample)
  skin.enabled = true
  skin.model = candidate.model as SkinConfig['model']
  skin.skinFile = relativeSkinFile
  if (!skin.onlineProvider.profileName) skin.onlineProvider.profileName = config.server.username
  await writeJson(files.skin, skin)
  return { ...dimensions, file: relativeSkinFile }
}

async function sendSkinImage(response: ServerResponse): Promise<void> {
  const skin = await readJson<SkinConfig>(files.skin, files.skinExample)
  const target = path.resolve(projectRoot, skin.skinFile)
  const allowedRoot = path.join(projectRoot, 'data', 'skins')
  if (!target.startsWith(`${allowedRoot}${path.sep}`)) throw new Error('皮肤文件路径不在 data/skins 内')
  const content = await readFile(target)
  validateMinecraftSkin(content)
  response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(content.length), 'cache-control': 'no-store' })
  response.end(content)
}

async function sendStorageDownload(response: ServerResponse, kind: 'memory' | 'experience'): Promise<void> {
  const config = await readJson<BotConfig>(files.config, files.configExample)
  const configured = kind === 'memory' ? config.storage.memoryFile : config.storage.experienceFile
  const target = path.resolve(projectRoot, configured)
  const allowedRoot = path.join(projectRoot, 'data')
  if (!target.startsWith(`${allowedRoot}${path.sep}`)) throw new Error('存储文件路径不在 data 内')
  const content = await readFile(target)
  JSON.parse(content.toString('utf8'))
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${kind}.json"`, 'cache-control': 'no-store' })
  response.end(content)
}

async function api(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  if (request.method === 'GET' && pathname === '/api/snapshot') return json(response, 200, await snapshot())
  if (request.method === 'GET' && pathname === '/api/diagnostics') return json(response, 200, await centralChatSnapshot())
  if (request.method === 'POST' && pathname === '/api/admin/command') {
    const payload = object(await body(request), 'adminCommand')
    if (typeof payload.message !== 'string') throw new Error('message 必须是字符串')
    const command = await adminInbox.submit(payload.message)
    return json(response, 202, { ok: true, command: { id: command.id, status: command.status, createdAt: command.createdAt } })
  }
  if (request.method === 'GET' && pathname === '/api/skin/image') return await sendSkinImage(response)
  if (request.method === 'GET' && pathname === '/api/memory/download') return await sendStorageDownload(response, 'memory')
  if (request.method === 'GET' && pathname === '/api/experience/download') return await sendStorageDownload(response, 'experience')
  if (request.method === 'PUT' && pathname === '/api/settings') {
    const payload = object(await body(request), 'settings')
    validateConfig(payload.config as BotConfig)
    validatePersona(payload.persona)
    validatePrompts(payload.prompts)
    validatePromptDocuments(payload.agentPrompts)
    validateSkin(payload.skin)
    validateRules(payload.rules)
    validateMods(payload.mods)
    ensureProjectPaths(payload.config as WebUiBotConfig)
    ensureSkinPaths(payload.skin as SkinConfig)
    const workspace = promptWorkspace(payload.config as WebUiBotConfig)
    await Promise.all([
      writeJson(files.config, payload.config), writeJson(files.persona, payload.persona), writeJson(files.prompts, payload.prompts), writeJson(files.skin, payload.skin),
      writeJson(files.rules, payload.rules), writeJson(files.mods, payload.mods), workspace.writeDocuments(payload.agentPrompts)
    ])
    return json(response, 200, { ok: true })
  }
  if (request.method === 'PUT' && pathname === '/api/player-profile') {
    const payload = object(await body(request), 'playerProfile')
    if (typeof payload.id !== 'string' || typeof payload.content !== 'string') throw new Error('玩家画像 id/content 无效')
    const config = await readJson<WebUiBotConfig>(files.config, files.configExample)
    const saved = await promptWorkspace(config).writePlayerProfile(payload.id, payload.content)
    return json(response, 200, { ok: true, profile: saved })
  }
  if (request.method === 'PUT' && pathname === '/api/secrets') {
    await updateSecrets(await body(request))
    return json(response, 200, { ok: true, secrets: await secretState() })
  }
  if (request.method === 'DELETE' && pathname === '/api/secrets') {
    await updateSecrets(Object.fromEntries(secretKeys.map(key => [key, null])))
    return json(response, 200, { ok: true, secrets: await secretState() })
  }
  if (request.method === 'POST' && pathname === '/api/lan/discover') {
    const config = await readJson<BotConfig>(files.config, files.configExample)
    return json(response, 200, { ok: true, servers: await discoverLanServers(config.server.lanDiscoveryTimeoutMs) })
  }
  if (request.method === 'POST' && pathname === '/api/skin/import') return json(response, 200, { ok: true, skin: await importSkin(await body(request)) })
  if (request.method === 'POST' && pathname === '/api/skin/pack') return json(response, 200, { ok: true, output: await runPowerShell('build-skin-pack.ps1') })
  if (request.method === 'POST' && pathname === '/api/mods/sync') {
    const result = await execFileAsync(process.execPath, [path.join(projectRoot, 'scripts', 'sync-client-mods.mjs')], { cwd: projectRoot, timeout: 5 * 60_000, windowsHide: true })
    return json(response, 200, { ok: true, output: result.stdout.trim(), snapshot: await snapshot() })
  }
  if (request.method === 'POST' && pathname === '/api/runtime/start') return json(response, 200, { ok: true, output: await runPowerShell('start-all-background.ps1') })
  if (request.method === 'POST' && pathname === '/api/runtime/stop') return json(response, 200, { ok: true, output: await runPowerShell('stop-all-background.ps1') })
  if (request.method === 'POST' && pathname === '/api/runtime/restart') {
    await runPowerShell('stop-all-background.ps1')
    return json(response, 200, { ok: true, output: await runPowerShell('start-all-background.ps1') })
  }
  if (request.method === 'POST' && pathname === '/api/model/test') {
    const started = Date.now()
    const loaded = await loadProjectConfig()
    const logger = new Logger({ file: 'logs/webui-model-test.log', level: 'error', console: false })
    const provider = createLlmProvider(loaded.config.model, loaded.apiKey, logger)
    const result = await provider.complete({ system: 'Return only a compact JSON object.', user: 'Reply with {"ok":true}. Do not add any other fields.' })
    await logger.flush()
    return json(response, 200, { ok: true, model: result.model, requestedEffort: result.requestedEffort, effectiveEffort: result.effectiveEffort, elapsedMs: Date.now() - started, usage: result.usage ?? null, capabilities: provider.capabilities ?? null })
  }
  json(response, 404, { ok: false, error: '接口不存在' })
}

function allowedRequest(request: IncomingMessage): boolean {
  const requestHost = (request.headers.host ?? '').split(':')[0]?.replace(/^\[|\]$/gu, '')
  if (!['127.0.0.1', 'localhost', '::1'].includes(requestHost ?? '')) return false
  const origin = request.headers.origin
  return !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
}

const staticTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }
const server = createServer(async (request, response) => {
  response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('cache-control', 'no-store')
  try {
    if (!allowedRequest(request)) return json(response, 403, { ok: false, error: 'WebUI 只允许本机访问' })
    const pathname = new URL(request.url ?? '/', `http://${request.headers.host}`).pathname
    if (pathname.startsWith('/api/')) return await api(request, response, pathname)
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
    const target = path.resolve(publicRoot, relative)
    if (!target.startsWith(`${publicRoot}${path.sep}`)) return json(response, 403, { ok: false, error: '路径无效' })
    const content = await readFile(target)
    response.writeHead(200, { 'content-type': staticTypes[path.extname(target)] ?? 'application/octet-stream' })
    response.end(content)
  } catch (error) {
    json(response, 500, { ok: false, error: errorMessage(error) })
  }
})

server.listen(port, host, () => console.log(`Minecraft AI Control Center: http://${host}:${port}`))
