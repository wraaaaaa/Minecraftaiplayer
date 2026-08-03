import { execFile } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { access, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { loadProjectConfig, validateConfig } from '../config/load-config.js'
import type { BehaviorRules, BotConfig, ModsConfig, Persona } from '../config/types.js'
import { Logger } from '../core/logger.js'
import { createLlmProvider } from '../llm/provider-factory.js'
import type { RuntimeStatus } from '../runtime/status-store.js'

const execFileAsync = promisify(execFile)
const projectRoot = path.resolve(process.cwd())
const publicRoot = path.join(projectRoot, 'public', 'webui')
const port = Number.parseInt(process.env.MCAI_WEBUI_PORT ?? '3210', 10)
const host = '127.0.0.1'
const MAX_BODY_BYTES = 1024 * 1024
const secretKeys = ['MINECRAFT_LOGIN_PASSWORD', 'DEEPSEEK_API_KEY', 'ARK_API_KEY', 'OPENAI_API_KEY'] as const

const files = {
  config: path.join(projectRoot, 'config', 'bot.json'),
  configExample: path.join(projectRoot, 'config', 'bot.example.json'),
  persona: path.join(projectRoot, 'config', 'persona.json'),
  personaExample: path.join(projectRoot, 'config', 'persona.example.json'),
  rules: path.join(projectRoot, 'config', 'behavior-rules.json'),
  mods: path.join(projectRoot, 'config', 'mods.json'),
  modsExample: path.join(projectRoot, 'config', 'mods.example.json'),
  env: path.join(projectRoot, '.env'),
  modManifest: path.join(projectRoot, '.runtime', 'minecraft', 'managed-mods.json'),
  botPid: path.join(projectRoot, 'data', 'bot.pid.json'),
  clientPid: path.join(projectRoot, 'data', 'minecraft-client.pid.json'),
  runtimeStatus: path.join(projectRoot, 'data', 'runtime-status.json'),
  botLog: path.join(projectRoot, 'logs', 'bot.log'),
  gameLog: path.join(projectRoot, '.runtime', 'minecraft', 'logs', 'latest.log')
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true } catch { return false }
}

async function readJson<T>(primary: string, fallback?: string): Promise<T> {
  const selected = await exists(primary) ? primary : fallback
  if (!selected) throw new Error(`文件不存在：${primary}`)
  return JSON.parse(await readFile(selected, 'utf8')) as T
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
    if (size > MAX_BODY_BYTES) throw new Error('请求内容超过 1 MiB 限制')
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
}

function validateMods(value: unknown): asserts value is ModsConfig {
  const candidate = object(value, 'mods')
  if (typeof candidate.sourceDirectory !== 'string') throw new Error('mods.sourceDirectory 必须是字符串')
  if (typeof candidate.syncOnClientStart !== 'boolean') throw new Error('mods.syncOnClientStart 必须是布尔值')
  if (!Array.isArray(candidate.excludeFilePatterns) || !(candidate.excludeFilePatterns as unknown[]).every(item => typeof item === 'string')) throw new Error('排除规则必须是字符串数组')
  for (const pattern of candidate.excludeFilePatterns as string[]) new RegExp(pattern, 'iu')
}

function ensureProjectPaths(config: BotConfig): void {
  const checks: Array<[string, string]> = [
    [config.personaFile, path.join(projectRoot, 'config')],
    [config.policyFile, path.join(projectRoot, 'config')],
    [config.storage.memoryFile, path.join(projectRoot, 'data')],
    [config.storage.experienceFile, path.join(projectRoot, 'data')],
    [config.logging.file, path.join(projectRoot, 'logs')]
  ]
  for (const [configured, allowedRoot] of checks) {
    const resolved = path.resolve(projectRoot, configured)
    if (resolved !== allowedRoot && !resolved.startsWith(`${allowedRoot}${path.sep}`)) throw new Error(`WebUI 不允许把文件写到项目范围外：${configured}`)
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.server.bridgeHost)) throw new Error('Fabric 桥必须绑定本机回环地址')
}

async function processStatus(pidFile: string): Promise<{ running: boolean; pid?: number }> {
  try {
    const record = await readJson<{ pid: number }>(pidFile)
    process.kill(record.pid, 0)
    return { running: true, pid: record.pid }
  } catch { return { running: false } }
}

async function tail(file: string, lineCount = 30): Promise<string[]> {
  try { return (await readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).slice(-lineCount) } catch { return [] }
}

async function secretState(): Promise<Record<string, boolean>> {
  const text = await readFile(files.env, 'utf8').catch(() => '')
  return Object.fromEntries(secretKeys.map(key => {
    const match = text.match(new RegExp(`^${key}=(.*)$`, 'mu'))
    return [key, Boolean(process.env[key]?.trim() || match?.[1]?.trim())]
  }))
}

async function snapshot(): Promise<unknown> {
  const [config, persona, rules, mods, manifest, live, bot, client, secrets, botLogs, gameLogs] = await Promise.all([
    readJson<BotConfig>(files.config, files.configExample),
    readJson<Persona>(files.persona, files.personaExample),
    readJson<BehaviorRules>(files.rules),
    readJson<ModsConfig>(files.mods, files.modsExample),
    readJson<{ sourceDirectory?: string; syncedAt?: string; files?: Array<{ name: string; size: number; sha256: string }> }>(files.modManifest).catch(() => ({ files: [] })),
    readJson<RuntimeStatus>(files.runtimeStatus).catch(() => null),
    processStatus(files.botPid), processStatus(files.clientPid), secretState(), tail(files.botLog), tail(files.gameLog)
  ])
  return { config, persona, rules, mods, manifest, live, runtime: { bot, client }, secrets, logs: { bot: botLogs, game: gameLogs } }
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
  const values = new Map<string, string>()
  for (const line of existing.split(/\r?\n/u)) {
    const separator = line.indexOf('=')
    if (separator > 0) values.set(line.slice(0, separator).trim(), line.slice(separator + 1))
  }
  for (const key of secretKeys) {
    const supplied = candidate[key]
    if (supplied === undefined || supplied === '') continue
    if (typeof supplied !== 'string' || /[\r\n]/u.test(supplied)) throw new Error(`${key} 格式无效`)
    values.set(key, supplied)
    process.env[key] = supplied
  }
  const contents = `${secretKeys.map(key => `${key}=${values.get(key) ?? ''}`).join('\n')}\n`
  const temporary = `${files.env}.${process.pid}.tmp`
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, files.env)
}

async function api(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  if (request.method === 'GET' && pathname === '/api/snapshot') return json(response, 200, await snapshot())
  if (request.method === 'PUT' && pathname === '/api/settings') {
    const payload = object(await body(request), 'settings')
    validateConfig(payload.config as BotConfig)
    validatePersona(payload.persona)
    validateRules(payload.rules)
    validateMods(payload.mods)
    ensureProjectPaths(payload.config as BotConfig)
    await Promise.all([
      writeJson(files.config, payload.config), writeJson(files.persona, payload.persona),
      writeJson(files.rules, payload.rules), writeJson(files.mods, payload.mods)
    ])
    return json(response, 200, { ok: true })
  }
  if (request.method === 'PUT' && pathname === '/api/secrets') {
    await updateSecrets(await body(request))
    return json(response, 200, { ok: true, secrets: await secretState() })
  }
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
    return json(response, 200, { ok: true, model: result.model, requestedEffort: result.requestedEffort, effectiveEffort: result.effectiveEffort, elapsedMs: Date.now() - started })
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
